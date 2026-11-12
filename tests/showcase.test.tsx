/**
 * Showcase mode (ui/showcase, docs/research/showcase-spec.md): the beat list, the tempo classes, the rule that it shows
 * only the figure and the charts, skipping what a host cannot show, restoring everything, and the window drivers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { signal } from "@preact/signals";
import { Modal, type Scope } from "obsidian";
import { render } from "preact-render-to-string";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keymap, Scope as DesktopScope } from "../src/desktop/obsidian/component";
import { ORDER_CHOICES } from "../src/shared/chartAxes";
import type { DimId } from "../src/shared/dims";
import type { DataIndex } from "../src/shared/index-format";
import { SETTINGS_WINDOW_EVENT } from "../src/shared/settingsTabs";
import type { SpaceId } from "../src/shared/types";
import { USER_SPACE_TOKEN_PREFIX, userSpaceTokens, type UserSpace } from "../src/shared/userSpaces";
import * as A from "../src/state/actions";
import type { CameraMoveLeg } from "../src/state/events";
import { appLocked, unlockApp } from "../src/state/lock";
import type { CortexStore } from "../src/state/store";
import type { ViewControls } from "../src/state/types";
import type { LeafServices } from "../src/plugin/services";
import { adoptShell, LeafContext, pendingCopy, ServicesContext, Shell, stageBus } from "../src/ui/context";
import { COPY } from "../src/ui/copy";
import { registerKeymap } from "../src/ui/keymap";
import {
  closeMenus,
  holdPointer,
  modalOpen,
  MUTED_ANYWHERE,
  MUTED_IN_PAGE,
  MUTED_OVERLAYS,
  muteOverlays,
  openMenus,
  restoreTilt,
  rememberTilt,
  tiltWindow,
  tourIsDriving,
} from "../src/ui/showcase/dom";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import {
  buildShowcase,
  offeredCharts,
  offeredLayouts,
  seeded,
  SHOWCASE_BEATS,
  TEMPO_ALLOWED,
  tempoOf,
  tourDim,
  type BeatId,
  type ShowcaseCtx,
  type ShowcaseEnv,
  type ShowcaseStep,
} from "../src/ui/showcase/registry";
import { anyShowcaseRunning, arrangementChanges, leafOwnsKeys, showcaseEnv, showcaseRunning, startShowcase, stopShowcase, toggleShowcase } from "../src/ui/showcase/runner";
import { richnessHint } from "../src/ui/stage/Hints";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";
// The stub behind "obsidian" in the tests: its Notice keeps every message it was given.
import { Notice } from "./stubs/obsidian";

const ENV: ShowcaseEnv = {
  layouts: offeredLayouts(),
  charts: offeredCharts(),
  themes: ["garnet", "sapphire", "verdant", "saffron", "default"],
  areas: ["claude-code", "vault", "life"] as unknown as SpaceId[],
  palettes: ["signal", "harbor", "orchard", "ember"],
};

/** The beats, in order: the figure and its charts only (no page or tab, start screen, Display panel, reader, Settings or add sheet). */
const ALL_BEATS: BeatId[] = ["open", "inside", "orbit", "fly", "lens", "colours", "groups", "charts", "picks", "names"];

/** A label grouping (the kind whose thin values bring up the coverage note with Add sources). */
const LABEL_DIM = "label:session/work" as DimId;

interface Recorded {
  ctx: ShowcaseCtx;
  calls: string[];
  legs: CameraMoveLeg[][];
  timers: { ms: number; fn: () => void }[];
}

function recordingCtx(h: FakeHarness, extra: Partial<ShowcaseCtx> = {}): Recorded {
  const calls: string[] = [];
  const legs: CameraMoveLeg[][] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  const ctx: ShowcaseCtx = {
    store: h.leaf.store,
    count: 100,
    base: h.leaf.store.get("view"),
    grow: () => void calls.push("grow"),
    home: () => void calls.push("home"),
    camera: (l) => void legs.push(l),
    morph: (to, ms) => void calls.push(`morph:${to}:${ms}`),
    theme: (id) => void calls.push(`theme:${id}`),
    entries: (n) => Array.from({ length: n }, (_, i) => ({ ordinal: i * 7, id: `e_${i}` })),
    after: (ms, fn) => void timers.push({ ms, fn }),
    palette: (id) => void calls.push(`palette:${id}`),
    tilt: (t) => void calls.push(t ? `tilt:${t.rx.toFixed(1)}` : "tilt:off"),
    ...extra,
  };
  return { ctx, calls, legs, timers };
}

const find = (steps: readonly ShowcaseStep[], id: string): ShowcaseStep => steps.find((s) => s.id === id) as ShowcaseStep;

/**
 * The user's rule (2026-11-12) for any moment of the tour: no popover (the Display panel is one), no page parked as a
 * tab, no reader previewed, no Ask console or Find list, no tooltip, never a grouping that brings up the coverage note
 * (Add sources), and the sheet closed: no page or tab at all, not even Chart or Time (the user's rule of the same day).
 * With `base` (the person's view): a categorical colour other than theirs is only ever the
 * dimension preview, so the controller never writes a new colour to the record's colour file. With `shell` (a running
 * tour's): the shape bar's own panel is shut and no toast is up.
 */
function expectFigureAndChartsOnly(store: CortexStore, where: string, base?: ViewControls, shell?: Shell): void {
  const ui = store.get("ui");
  const v = store.get("view");
  if (shell) {
    expect(shell.shapeOpen.value, where).toBe(false);
    expect(shell.toasts.value, where).toEqual([]);
  }
  expect(ui.popover, where).toBeNull();
  expect(ui.sheetPreview, where).toBeNull();
  expect(ui.sheet.stash, where).toBeUndefined();
  expect(ui.command.consoleOpen, where).toBe(false);
  expect(ui.command.resultsOpen, where).toBe(false);
  expect(store.get("hover"), where).toBeNull();
  // The note's own rule, at full morph and with the thinnest value there is: it must never have a grouping to speak of.
  const recordDim = v.splitGroups && v.layers.record ? (v.groupByRecord ?? v.groupBy) : null;
  expect(richnessHint({ shape: v.shape, morph: 1, groupBy: v.groupBy, recordDim, thinnest: 1 }), where).toBeNull();
  if (base) {
    for (const pop of ["notes", "record"] as const) {
      const m = v.colour[pop];
      const own = base.colour[pop];
      if (m.kind !== "categorical" || (own.kind === "categorical" && own.dim === m.dim)) continue;
      expect(pop, where).toBe("notes");
      expect(ui.dimPreview, where).toBe(m.dim);
    }
  }
  expect(ui.sheet.open, where).toBe(false);
}

describe("the beat list", () => {
  it("is the figure and the charts only, every beat with steps, and unique step ids", () => {
    expect(SHOWCASE_BEATS.map((b) => b.id)).toEqual(ALL_BEATS);
    const steps = buildShowcase(ENV);
    for (const beat of ALL_BEATS) expect(steps.some((s) => s.beat === beat)).toBe(true);
    const ids = steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("opens cold on the figure: the growth, then the inside-the-brain pull-back, and no start screen", () => {
    const steps = buildShowcase(ENV, 1);
    expect(steps.slice(0, 2).map((s) => s.id)).toEqual(["open-grow", "inside-pull"]);
    expect(steps[0]?.tempo).toBe("hold");
    for (const seed of [1, 2, 3]) expect(buildShowcase(ENV, seed).filter((s) => s.beat === "open").map((s) => s.id)).toEqual(["open-grow"]);
  });

  it("covers every lens, colour, chart, grouping layout and pick the record and build offer", () => {
    const steps = buildShowcase(ENV, 3);
    expect(steps.filter((s) => s.beat === "lens").length).toBeGreaterThanOrEqual(4);
    expect(steps.filter((s) => s.beat === "colours").length).toBeGreaterThanOrEqual(6);
    // Every chart the build offers flips in once.
    const flipped = steps.filter((s) => s.beat === "charts").map((s) => /^charts-(.+)-\d+$/.exec(s.id)?.[1]);
    expect(flipped.filter((id) => id !== undefined).sort()).toEqual([...ENV.charts].sort());
    // Every layout the build offers is one of the groupings.
    const grouped = steps.filter((s) => s.beat === "groups" && s.id !== "groups-reset" && s.id !== "groups-back");
    expect(grouped.length).toBeGreaterThanOrEqual(ENV.layouts.length);
    for (const layout of ENV.layouts) expect(grouped.some((s) => s.id.includes(`-${layout}-`))).toBe(true);
    expect(steps.filter((s) => s.beat === "picks").length).toBeGreaterThanOrEqual(4);
    // No step opens a page or a tab, or drops a picker open.
    expect(steps.filter((s) => s.id.startsWith("time-") || s.id.includes("-menu-"))).toEqual([]);
  });

  it("works with no label anywhere: a step carries no text for the screen", () => {
    for (const s of buildShowcase(ENV)) expect(Object.keys(s)).not.toContain("label");
    expect(JSON.stringify(COPY)).not.toMatch(/"showcase":\s*\{[^}]*(running|stopHint|started|stopped)/);
  });
});

describe("tempo classes and pace", () => {
  it("gives every step a hold inside its class, and the class edges follow the spec", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const s of buildShowcase(ENV, seed)) {
        const [lo, hi] = TEMPO_ALLOWED[s.tempo];
        expect(s.hold).toBeGreaterThanOrEqual(lo);
        expect(s.hold).toBeLessThanOrEqual(hi);
        expect(tempoOf(s.hold)).toBe(s.tempo);
      }
    }
    expect(tempoOf(300)).toBe("burst");
    expect(tempoOf(600)).toBe("normal");
    expect(tempoOf(1200)).toBe("hold");
  });

  it("holds only on the figure: the long holds belong to the opening, the inside pull, the orbit and the fly-through", () => {
    for (const seed of [1, 2, 3]) {
      const held = new Set(buildShowcase(ENV, seed).filter((s) => s.tempo === "hold").map((s) => s.beat));
      for (const b of held) expect(["open", "inside", "orbit", "fly"]).toContain(b);
    }
  });

  it("cuts about every half second, and a lap lasts 40 to 70 s (it lost the Chart card's pickers and the Time page)", () => {
    const r = recordingCtx(fakeServices());
    for (let seed = 1; seed <= 20; seed++) {
      // With a window, a preview and a record every step plays, so this is the whole lap.
      const steps = buildShowcase(ENV, seed);
      expect(steps.every((s) => s.available?.(r.ctx) !== false)).toBe(true);
      const total = steps.reduce((n, s) => n + s.hold, 0);
      const mean = total / steps.length;
      expect(mean).toBeGreaterThanOrEqual(450);
      expect(mean).toBeLessThanOrEqual(750);
      expect(total).toBeGreaterThanOrEqual(40_000);
      expect(total).toBeLessThanOrEqual(70_000);
      // Most of the loop is quick cuts: a step under 0.8 s is the norm.
      expect(steps.filter((s) => s.hold <= 760).length / steps.length).toBeGreaterThan(0.8);
    }
  });

  it("uses bursts for the flips and normal beats for the charts and groupings", () => {
    const steps = buildShowcase(ENV, 2);
    for (const s of steps.filter((x) => x.beat === "lens")) expect(s.tempo).toBe("burst");
    for (const s of steps.filter((x) => x.id.startsWith("colours-theme") || x.id.startsWith("colours-palette"))) expect(s.tempo).toBe("burst");
    for (const s of steps.filter((x) => x.beat === "groups")) expect(s.tempo).toBe("normal");
    for (const s of steps.filter((x) => /^charts-.+-\d+$/.test(x.id))) expect(s.tempo).toBe("normal");
    for (const s of steps.filter((x) => x.beat === "picks" && x.id !== "picks-0")) expect(s.tempo).toBe("burst");
  });
});

describe("order and seeding", () => {
  it("builds the same lap from the same seed and a different order from another", () => {
    const order = (seed: number) => [...new Set(buildShowcase(ENV, seed).map((s) => s.beat))].join(",");
    expect(order(4)).toBe(order(4));
    expect(buildShowcase(ENV, 4).map((s) => `${s.id}:${s.hold}`)).toEqual(buildShowcase(ENV, 4).map((s) => `${s.id}:${s.hold}`));
    const orders = new Set([2, 3, 4, 5, 6].map(order));
    expect(orders.size).toBeGreaterThanOrEqual(4);
    // Later laps shuffle the opening too, but every beat is still there.
    for (const beat of ALL_BEATS) expect(buildShowcase(ENV, 6).some((s) => s.beat === beat)).toBe(true);
  });

  it("the seeded generator is stable and spread over 0 to 1", () => {
    const a = seeded(9);
    const b = seeded(9);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});

describe("what the beats do", () => {
  it("the camera beats fly legs: inside the brain, close-ups, the comet tilt, far out, and a fly-through past real points", () => {
    const h = fakeServices();
    const r = recordingCtx(h);
    const steps = buildShowcase(ENV, 1);
    find(steps, "inside-pull").run(r.ctx);
    expect(r.legs[0]?.[0]).toMatchObject({ at: "brain" });
    expect(r.legs[0]?.[0]?.distance).toBeLessThan(0.1);
    expect(r.legs[0]?.at(-1)).toMatchObject({ at: "home", distance: 1 });
    const orbit = buildShowcase(ENV, 2);
    for (const id of ["orbit-brain", "orbit-neck", "orbit-comet", "orbit-far", "orbit-push"]) find(orbit, id).run(r.ctx);
    const comet = r.legs.find((l) => Math.abs(l[0]?.rollDeg ?? 0) === 90);
    expect(comet).toBeTruthy();
    expect(r.legs.some((l) => (l[0]?.distance ?? 0) > 2.5)).toBe(true);
    expect(r.legs.at(-1)?.[0]).toMatchObject({ distance: 1, rollDeg: 0 });
    const before = r.legs.length;
    find(buildShowcase(ENV, 3), "fly-through").run(r.ctx);
    const path = r.legs[before] as CameraMoveLeg[];
    expect(path.length).toBeGreaterThanOrEqual(3);
    for (const leg of path) {
      expect(typeof leg.at).toBe("object");
      expect((leg.at as { ordinal: number }).ordinal).toBeLessThan(100);
      expect(leg.distance).toBeLessThan(0.2);
      expect(leg.ease).toBe("linear");
    }
  });

  it("the opening grows the figure on the next tick, from the body at home", () => {
    const h = fakeServices();
    const r = recordingCtx(h);
    A.setShape(h.leaf.store, "groups");
    find(buildShowcase(ENV, 1), "open-grow").run(r.ctx);
    expect(h.leaf.store.get("view").shape).toBe("body");
    expect(r.calls).toContain("home");
    expect(r.calls).not.toContain("grow");
    expect(r.timers.map((x) => x.ms)).toEqual([0]);
    r.timers[0]?.fn();
    expect(r.calls.at(-1)).toBe("grow");
  });

  it("lens flips change the area and each isolates it; the last returns to all areas", () => {
    const h = fakeServices();
    const r = recordingCtx(h);
    const steps = buildShowcase(ENV, 2).filter((s) => s.beat === "lens");
    const seen: string[] = [];
    for (const s of steps) {
      s.run(r.ctx);
      seen.push(String(h.leaf.store.get("ui").scope));
    }
    expect(new Set(seen).size).toBeGreaterThanOrEqual(3);
    expect(seen.at(-1)).toBe("all");
  });

  it("colour sweeps preview themes and palettes, colour the spine by time, and end on the person's own", () => {
    const h = fakeServices();
    const r = recordingCtx(h);
    const steps = buildShowcase(ENV, 2).filter((s) => s.beat === "colours");
    for (const s of steps) s.run(r.ctx);
    expect(r.calls.filter((c) => c.startsWith("theme:")).length).toBeGreaterThanOrEqual(3);
    expect(r.calls.filter((c) => c.startsWith("palette:") && c !== "palette:null").length).toBeGreaterThanOrEqual(2);
    expect(r.calls.at(-1)).toBe("palette:null");
    expect(h.leaf.store.get("view").colour).toEqual(r.ctx.base.colour);
    // Between those, the spine was coloured by time.
    const spine = find(steps, "colours-spine-by-time");
    spine.run(r.ctx);
    expect(h.leaf.store.get("view").colour.record).toEqual({ kind: "age" });
  });

  it("groupings flick as quick cuts: each sets the grouping and layout and morphs in under 250 ms", () => {
    const h = fakeServices();
    const r = recordingCtx(h);
    const steps = buildShowcase(ENV, 2).filter((s) => s.beat === "groups");
    const layouts = new Set<string>();
    const cuts = new Set<string>();
    for (const s of steps) {
      s.run(r.ctx);
      const v = h.leaf.store.get("view");
      layouts.add(v.layout);
      if (v.shape === "groups") cuts.add(`${v.groupBy}|${v.layout}`);
    }
    expect(layouts.size).toBeGreaterThanOrEqual(3);
    // No grouping is shown twice in one run.
    expect(cuts.size).toBe(steps.length - 2);
    for (const c of r.calls.filter((x) => x.startsWith("morph:"))) expect(Number(c.split(":")[2])).toBeLessThanOrEqual(250);
  });

  it("the chart run flips every chart the build offers on the figure itself and opens no page, tab, card or picker", () => {
    const h = fakeServices();
    const r = recordingCtx(h);
    const store = h.leaf.store;
    const steps = buildShowcase(ENV, 2).filter((s) => s.beat === "charts");
    const specs = new Set<string>();
    for (const s of steps) {
      s.run(r.ctx);
      const v = store.get("view");
      if (v.shape === "chart" && v.chart) specs.add(v.chart.chart);
      expect(store.get("ui").sheet.open, s.id).toBe(false);
      expect(store.get("ui").popover, s.id).toBeNull();
    }
    expect([...specs].sort()).toEqual([...ENV.charts].sort());
    expect(store.get("ui").sheet.stack).toEqual([]);
    // The beat ends by morphing back to the figure.
    expect(r.calls.at(-1)).toBe("morph:0:220");
  });

  it("picks select three to five different entries on the figure, each drawing its lines, and open nothing", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    // A person who keeps links off: the picks still draw each entry's lines, and the setting comes back after.
    A.setLook(store, { lines: "off" });
    const r = recordingCtx(h);
    const gestures: string[] = [];
    stageBus(h.services.bus).on("stage:point", (e) => void gestures.push(e.gesture));
    const steps = buildShowcase(ENV, 2).filter((s) => s.beat === "picks");
    const chosen: string[] = [];
    for (const s of steps) {
      s.run(r.ctx);
      const sel = store.get("selection");
      if (sel) {
        chosen.push(sel.id);
        expect(store.get("view").look.lines).toBe("selection");
      }
      expect(store.get("ui").sheet.open).toBe(false);
      expect(store.get("ui").popover).toBeNull();
    }
    expect(new Set(chosen).size).toBe(chosen.length);
    expect(chosen.length).toBeGreaterThanOrEqual(3);
    expect(chosen.length).toBeLessThanOrEqual(5);
    // No reader was ever put on the sheet, and nothing reached the shell's point gestures (the way a click on a point opens one).
    expect(store.get("ui").sheet.stack).toEqual([]);
    expect(gestures).toEqual([]);
    expect(store.get("selection")).toBeNull();
    expect(store.get("view").look.lines).toBe("off");
    expect(h.saved).toHaveLength(0);
    for (const s of steps.filter((x) => x.id !== "picks-0" && x.id !== "picks-clear")) expect(s.hold).toBeLessThanOrEqual(520);
  });

  it("flashes the names over the figure and takes them off again", () => {
    const h = fakeServices();
    const r = recordingCtx(h);
    const steps = buildShowcase(ENV, 2);
    find(steps, "names-flash").run(r.ctx);
    expect(h.leaf.store.get("view").look).toMatchObject({ names: "always", density: "all" });
    find(steps, "names-off").run(r.ctx);
    expect(h.leaf.store.get("view").look.names).toBe(r.ctx.base.look.names);
  });

  it("tilts the whole window a few times a lap, never overlapping, and every tilt is settled within its lap", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const h = fakeServices();
      const r = recordingCtx(h);
      const steps = buildShowcase(ENV, seed);
      for (const s of steps) s.run(r.ctx);
      const tilts = r.calls.filter((c) => c.startsWith("tilt:"));
      const ons = tilts.filter((c) => c !== "tilt:off").length;
      // About every ten steps: six to eight times a lap, never fewer than two.
      expect(ons, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(ons, `seed ${seed}`).toBeLessThanOrEqual(8);
      let open = false;
      for (const c of tilts) {
        if (c === "tilt:off") open = false;
        else {
          expect(open).toBe(false);
          open = true;
        }
      }
      // A lap never ends tilted: the last move of the window is always the one back to rest.
      expect(open, `seed ${seed}`).toBe(false);
      expect(tilts.at(-1), `seed ${seed}`).toBe("tilt:off");
    }
  });

  it("groups and flashes names by no label field and never splits notes and record, colouring through the preview", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    // A person who groups by a label field, with the record split off by Your labels: either would bring the coverage note up.
    A.setGroupBy(store, LABEL_DIM);
    A.setSplitGroups(store, true);
    A.setGroupByRecord(store, "yourLabels");
    const r = recordingCtx(h);
    const base = r.ctx.base;
    expect(tourDim(LABEL_DIM, "bubbles")).toBe("space");
    expect(tourDim("month", "wheel")).toBe("month");
    for (const seed of [1, 2, 3]) {
      const steps = buildShowcase(ENV, seed).filter((s) => s.beat === "groups" || s.beat === "names");
      for (const s of steps) {
        s.run(r.ctx);
        const v = store.get("view");
        expectFigureAndChartsOnly(store, `seed ${seed}, ${s.id}`, base);
        if (s.id === "groups-reset" || s.id === "groups-back" || s.id === "names-off") continue;
        expect(v.shape, s.id).toBe("groups");
        expect(v.splitGroups, s.id).toBe(false);
        expect(v.groupByRecord, s.id).toBeNull();
        // The key follows the grouping, shown as the preview (its colours are never kept).
        expect(store.get("ui").dimPreview, s.id).toBe(v.groupBy);
        expect(v.colour.notes, s.id).toEqual({ kind: "categorical", dim: v.groupBy });
      }
      // Each grouping ends with the person's colours back and the preview gone.
      expect(store.get("view").colour, `seed ${seed}`).toEqual(base.colour);
      expect(store.get("ui").dimPreview, `seed ${seed}`).toBeNull();
    }
  });
});

describe("only the figure and the charts (the user's rule)", () => {
  it("never shows a popover, a reader, any page or tab, the Ask console, Find's list, the coverage note, a dialog, Settings or a notice: every step of thirty laps", () => {
    const base = fakeServices();
    const app = base.services.app as unknown as { workspace: { on(n: string, cb: (...a: unknown[]) => void): unknown }; setting?: unknown };
    const settings: unknown[] = [];
    app.workspace.on(SETTINGS_WINDOW_EVENT, (section) => void settings.push(section));
    app.workspace.on("cortex:settings-section", (section) => void settings.push(section));
    // Cortex Desktop's own Settings page (the branded path).
    const branded = { branded: true, open: vi.fn(), openTabById: vi.fn() };
    app.setting = branded;
    const dialogs = vi.spyOn(Modal.prototype, "open");
    const notices = Notice.all.length;
    try {
      for (const open of ["find", "ask"] as const) {
        // A tour as the runner plays it (lap after lap from the cold open) on a fresh leaf (a real store), grouped by a label
        // field with the record split off (the person's own choices), with Find's list or the Ask console open as the chord is pressed.
        const h: FakeHarness = { ...base, leaf: base.services.createLeaf(`rule-${open}`) };
        const store = h.leaf.store;
        A.setGroupBy(store, LABEL_DIM);
        A.setSplitGroups(store, true);
        A.setGroupByRecord(store, "yourLabels");
        store.update("ui", (u) => ({ ...u, command: { ...u.command, mode: open, text: "rule", resultsOpen: open === "find", consoleOpen: open === "ask" } }));
        const r = recordingCtx(h);
        for (let seed = 1; seed <= 15; seed++) {
          for (const s of buildShowcase(ENV, seed)) {
            if (s.available?.(r.ctx) === false) continue;
            s.run(r.ctx);
            // The timers a step sets (the growth on the next tick) run before the check.
            for (const tm of r.timers.splice(0)) tm.fn();
            expectFigureAndChartsOnly(store, `${open}, seed ${seed}, ${s.id}`, r.ctx.base);
          }
        }
      }
      expect(dialogs).not.toHaveBeenCalled();
      expect(settings).toEqual([]);
      expect(branded.open).not.toHaveBeenCalled();
      expect(Notice.all.length).toBe(notices);
    } finally {
      dialogs.mockRestore();
    }
  });

  it("plays the same at S, in Mini and in immersive mode: every chart flips in on the figure, no step is passed over and no page opens", () => {
    for (const how of ["S", "Mini", "immersive"] as const) {
      const h = fakeServices();
      const store = h.leaf.store;
      if (how === "immersive") A.toggleImmersive(store);
      else store.update("ui", { breakpoint: how });
      const r = recordingCtx(h);
      const charted = new Set<string>();
      for (const s of buildShowcase(ENV, 2)) {
        expect(s.available?.(r.ctx), `${how} ${s.id}`).not.toBe(false);
        s.run(r.ctx);
        expect(store.get("ui").sheet.open, `${how} ${s.id}`).toBe(false);
        const v = store.get("view");
        if (s.beat === "charts" && v.shape === "chart" && v.chart) charted.add(v.chart.chart);
      }
      expect([...charted].sort(), how).toEqual([...ENV.charts].sort());
    }
  });
});

describe("skipping what a host cannot show", () => {
  it("passes over steps with no window, no preview and no record, and never throws on an empty record", () => {
    const h = fakeServices();
    const bare = recordingCtx(h, { palette: undefined, tilt: undefined, count: 0, entries: () => [] }).ctx;
    const steps = buildShowcase({ ...ENV, areas: [] });
    let skipped = 0;
    for (const s of steps) {
      if (s.available?.(bare) === false) {
        skipped++;
        continue;
      }
      expect(() => s.run(bare)).not.toThrow();
    }
    expect(skipped).toBeGreaterThan(15);
    for (const id of ["colours-own", "fly-through", "picks-1"]) {
      const s = steps.find((x) => x.id === id);
      expect(s, id).toBeDefined();
      expect(s?.available?.(bare), id).toBe(false);
    }
  });

  it("builds without lens flips on a record with fewer than two areas, and without charts when the build offers none", () => {
    const steps = buildShowcase({ ...ENV, areas: ["vault"] as unknown as SpaceId[], charts: [], layouts: [] });
    expect(steps.some((s) => s.beat === "lens")).toBe(false);
    expect(steps.some((s) => s.beat === "charts")).toBe(false);
  });
});

interface Fired {
  ev: { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn>; stopImmediatePropagation: ReturnType<typeof vi.fn>; defaultPrevented: boolean };
  /** Something on the way (the window or the document, in the capture phase) kept it from the page. */
  stopped: boolean;
}

/**
 * A window with a document, dispatching as a browser does in the capture phase: the window's listeners first (Cortex
 * Desktop's keymap listens there), then the document's (the tour's), then the page under the pointer (`reached`, the
 * stage's canvas), unless something on the way stopped it. A listener added while an event is on its way waits for the next one.
 */
function fakeWindowShell(
  rootStyle: Record<string, string> = { transform: "translateZ(0)", transition: "", willChange: "", transformOrigin: "" },
  opts: {
    viewId?: string;
    dom?: { querySelector?: (sel: string) => unknown; querySelectorAll?: (sel: string) => unknown[] };
    /** The document's own queries (menus, Obsidian's page preview) and body. */
    page?: { querySelectorAll?: (sel: string) => unknown[]; body?: unknown };
    /** More of the window (KeyboardEvent, MutationObserver). */
    win?: Record<string, unknown>;
  } = {},
): {
  shell: Shell;
  press: (k: string, extra?: object) => Fired;
  click: (extra?: object) => Fired;
  /** The rest of a press: its release, click or menu. */
  fire: (name: string, extra?: object) => Fired;
  wheel: () => Fired;
  move: (target?: unknown) => { stopped: boolean };
  style: Record<string, string>;
  /** The document's listeners (the window's are the app's). */
  listeners: () => number;
  /** How many events of a type reached the page under the pointer. */
  reached: (name: string) => number;
  /** A dialog is up in the window (or not). */
  dialog: (open: boolean) => void;
} {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const windowHandlers = new Map<string, Set<(e: unknown) => void>>();
  const onPage: string[] = [];
  const listen = (map: typeof handlers) => ({
    addEventListener: (n: string, f: (e: unknown) => void) => {
      if (!map.has(n)) map.set(n, new Set());
      map.get(n)?.add(f);
    },
    removeEventListener: (n: string, f: (e: unknown) => void) => void map.get(n)?.delete(f),
  });
  const win = {
    setTimeout: (f: () => void, ms: number) => globalThis.setTimeout(f, ms) as unknown as number,
    clearTimeout: (id: number) => globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    ...listen(windowHandlers),
    ...opts.win,
  };
  let modal = false;
  const doc = {
    defaultView: win,
    activeElement: null,
    ...listen(handlers),
    querySelector: (sel: string) => (sel === ".modal-container" && modal ? {} : null),
    querySelectorAll: opts.page?.querySelectorAll ?? (() => []),
    body: opts.page?.body,
  };
  const shell = new Shell(opts.viewId ?? "test-leaf");
  const style = { ...rootStyle };
  const inside = { inRoot: true };
  shell.root = {
    isConnected: true,
    ownerDocument: doc,
    getClientRects: () => [{}],
    style,
    contains: (n: unknown) => n === inside,
    querySelector: opts.dom?.querySelector ?? (() => null),
    querySelectorAll: opts.dom?.querySelectorAll ?? (() => []),
  } as unknown as HTMLElement;
  const fire = (name: string, e: object = {}): Fired => {
    let stopped = false;
    let immediate = false;
    const ev: Fired["ev"] & Record<string, unknown> = {
      type: name,
      cancelable: true,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: vi.fn(() => void (ev.defaultPrevented = true)),
      stopPropagation: vi.fn(() => void (stopped = true)),
      stopImmediatePropagation: vi.fn(() => void (stopped = immediate = true)),
      repeat: false,
      target: inside,
      ...e,
    };
    for (const phase of [windowHandlers, handlers]) {
      for (const f of [...(phase.get(name) ?? [])]) {
        f(ev);
        if (immediate) break;
      }
      if (stopped) break;
    }
    if (!stopped) onPage.push(name);
    return { ev, stopped };
  };
  return {
    shell,
    style,
    press: (k, extra = {}) => fire("keydown", { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }),
    click: (extra = {}) => fire("pointerdown", { button: 0, ...extra }),
    fire,
    wheel: () => fire("wheel", { deltaY: 100 }),
    move: (target = inside) => ({ stopped: fire("pointermove", { target }).stopped }),
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    reached: (name) => onPage.filter((n) => n === name).length,
    dialog: (open) => void (modal = open),
  };
}

describe("running and restoring", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    unlockApp();
  });

  it("shows nothing that says it is a showcase: no pill state on the shell and no step label", async () => {
    const h = fakeServices();
    const { shell, press } = fakeWindowShell();
    expect((shell as unknown as Record<string, unknown>).showcase).toBeUndefined();
    startShowcase(h.services, h.leaf, shell, buildShowcase(ENV));
    await vi.advanceTimersByTimeAsync(3000);
    expect(shell.announcement.value.text).toBe("");
    press("x");
    expect(shell.announcement.value.text).toBe("");
  });

  it("a key, a click or a wheel stops it and puts the view, popover, selection and window style back exactly", async () => {
    for (const how of ["key", "click", "wheel"] as const) {
      const h = fakeServices();
      const w = fakeWindowShell();
      const store = h.leaf.store;
      A.setLook(store, { names: "always" });
      A.openPopover(store, "key");
      const before = JSON.stringify(store.snapshot());
      const styleBefore = { ...w.style };
      expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(JSON.stringify(store.snapshot())).not.toBe(before);
      const stopper = how === "key" ? w.press("x") : how === "click" ? w.click() : w.wheel();
      expect(showcaseRunning(w.shell)).toBe(false);
      // The key, press or wheel that stopped it goes no further (no hotkey, no click on the stage, no zoom).
      expect(stopper.stopped, how).toBe(true);
      expect(JSON.stringify(store.snapshot())).toBe(before);
      expect(w.style).toEqual(styleBefore);
      // The rest of the press (its release and click) is swallowed, then those listeners go too.
      if (how === "click") {
        expect(w.fire("pointerup").stopped).toBe(true);
        expect(w.fire("click").stopped).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(800);
      expect(w.listeners()).toBe(0);
      expect(appLocked.value).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(JSON.stringify(store.snapshot())).toBe(before);
    }
  });

  it("restores the camera and clears the scripted path through the bus", async () => {
    const h = fakeServices();
    const { shell } = fakeWindowShell();
    const seen: string[] = [];
    for (const n of ["camera:save", "camera:restore", "camera:move"] as const) h.services.bus.on(n, (p: unknown) => void seen.push(n === "camera:move" ? `move:${(p as { legs: unknown[] }).legs.length}` : n));
    startShowcase(h.services, h.leaf, shell, buildShowcase(ENV, 1));
    await vi.advanceTimersByTimeAsync(3000);
    stopShowcase(shell);
    // Nothing to lay out again (the tour was on the body with the person's grouping): the pose goes back at once.
    expect(seen[0]).toBe("camera:save");
    expect(seen.slice(-2)).toEqual(["move:0", "camera:restore"]);
    expect(seen.some((s) => s.startsWith("move:") && s !== "move:0")).toBe(true);
  });

  it("hands the camera back only once the view it returns to is laid out again, so the controller's re-fit cannot carry it off", async () => {
    const groupsCut: ShowcaseStep = { id: "cut", beat: "groups", tempo: "normal", hold: 500, run: (c) => void c.store.update("view", { shape: "groups", groupBy: "month", layout: "wheel" }) };
    // The person on the body: the body comes back 24 ms after the store, and the pose just after that.
    {
      const h = fakeServices();
      const { shell } = fakeWindowShell();
      const seen: string[] = [];
      h.services.bus.on("camera:restore", () => void seen.push("restore"));
      startShowcase(h.services, h.leaf, shell, [groupsCut]);
      await vi.advanceTimersByTimeAsync(100);
      stopShowcase(shell);
      expect(arrangementChanges(h.leaf.store.get("view"), { ...h.leaf.store.get("view"), shape: "groups" })).toBe(true);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(30);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(40);
      expect(seen).toEqual(["restore"]);
    }
    // The person on a chart: the pose goes back as the worker's layout of that chart lands, is kept for a further layout
    // of the same view in the next moment (the chart re-fitted to its stage), and the person's first key ends it.
    {
      const h = fakeServices();
      const { shell, press, listeners } = fakeWindowShell();
      A.setView(h.leaf.store, "chart", { chart: "matrix", x: { dim: "space", sort: "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} });
      A.setShape(h.leaf.store, "chart");
      const seen: string[] = [];
      for (const n of ["camera:save", "camera:restore"] as const) h.services.bus.on(n, () => void seen.push(n));
      startShowcase(h.services, h.leaf, shell, [groupsCut]);
      await vi.advanceTimersByTimeAsync(450);
      press("x");
      expect(showcaseRunning(shell)).toBe(false);
      expect(seen).toEqual(["camera:save"]);
      await vi.advanceTimersByTimeAsync(500);
      expect(seen).toEqual(["camera:save"]);
      h.services.bus.emit("layout:arrangement", { viewId: "other-view", kind: "chart" });
      expect(seen).toEqual(["camera:save"]);
      h.services.bus.emit("layout:arrangement", { viewId: h.leaf.viewId, kind: "chart" });
      expect(seen).toEqual(["camera:save", "camera:restore", "camera:save"]);
      await vi.advanceTimersByTimeAsync(200);
      h.services.bus.emit("layout:arrangement", { viewId: h.leaf.viewId, kind: "chart" });
      expect(seen.slice(-2)).toEqual(["camera:restore", "camera:save"]);
      press("ArrowLeft");
      const n = seen.length;
      h.services.bus.emit("layout:arrangement", { viewId: h.leaf.viewId, kind: "chart" });
      expect(seen.length).toBe(n);
      expect(listeners()).toBe(0);
    }
    // No layout ever comes (no renderer): the pose goes back anyway after the wait.
    {
      const h = fakeServices();
      const { shell, listeners } = fakeWindowShell();
      A.setShape(h.leaf.store, "chart");
      const seen: string[] = [];
      h.services.bus.on("camera:restore", () => void seen.push("restore"));
      startShowcase(h.services, h.leaf, shell, [groupsCut]);
      await vi.advanceTimersByTimeAsync(100);
      stopShowcase(shell);
      await vi.advanceTimersByTimeAsync(3900);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(seen).toEqual(["restore"]);
      expect(listeners()).toBe(0);
    }
  });

  it("loops: when a lap ends the next one is built in a new order and the tour goes on", async () => {
    const h = fakeServices();
    const { shell } = fakeWindowShell();
    const laps: number[] = [];
    startShowcase(h.services, h.leaf, shell, (lap) => {
      laps.push(lap);
      return buildShowcase({ ...ENV, areas: [] }, lap + 1);
    });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(laps.length).toBeGreaterThanOrEqual(3);
    stopShowcase(shell);
  });

  it("passes over unavailable steps without a pause: a lap of nothing but unavailable steps does not spin", async () => {
    const h = fakeServices();
    const { shell } = fakeWindowShell();
    const none: ShowcaseStep = { id: "x", beat: "picks", tempo: "burst", hold: 300, available: () => false, run: () => undefined };
    expect(startShowcase(h.services, h.leaf, shell, [none, none])).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    stopShowcase(shell);
  });

  it("puts the window's scroll back where it was", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    const el = { scrollTop: 120, isConnected: true };
    (w.shell.root as unknown as { querySelectorAll: () => unknown[] }).querySelectorAll = () => [el];
    startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2));
    await vi.advanceTimersByTimeAsync(2000);
    el.scrollTop = 0;
    stopShowcase(w.shell);
    expect(el.scrollTop).toBe(120);
  });

  it("does not start while the app is locked, and never locks it itself", async () => {
    const h = fakeServices();
    const { shell } = fakeWindowShell();
    appLocked.value = true;
    expect(startShowcase(h.services, h.leaf, shell, buildShowcase(ENV, 1))).toBe(false);
    expect(showcaseRunning(shell)).toBe(false);
    appLocked.value = false;
    expect(startShowcase(h.services, h.leaf, shell, buildShowcase(ENV, 1))).toBe(true);
    for (let i = 0; i < 100; i++) {
      await vi.advanceTimersByTimeAsync(300);
      expect(appLocked.value).toBe(false);
    }
    stopShowcase(shell);
  });

  it("gives its steps only the hooks for the figure and the charts (none for the add sheet, Settings, the start screen or a reader), even where a host could show them", () => {
    // First run done and no encryption: a host where the add sheet, Settings and the lock card could all be shown.
    const h = fakeServices((x) => void (x.general.firstRunDone = true));
    const { shell } = fakeWindowShell();
    const seen: ShowcaseCtx[] = [];
    const probe: ShowcaseStep = { id: "probe", beat: "names", tempo: "normal", hold: 500, run: (c) => void seen.push(c) };
    expect(startShowcase(h.services, h.leaf, shell, [probe])).toBe(true);
    stopShowcase(shell);
    const ctx = seen[0] as ShowcaseCtx;
    expect(ctx).toBeDefined();
    // Exactly these, so a hook added (or renamed) for anything else fails here. Every one moves only the view: the store,
    // the renderer, the colour preview and the window's tilt (none opens a page, a tab or a menu).
    expect(Object.keys(ctx).sort()).toEqual(["after", "base", "camera", "count", "entries", "grow", "home", "morph", "palette", "store", "theme", "tilt"]);
    expect(typeof ctx.entries).toBe("function");
  });

  it("on a real container with a loaded record: the page, panels, Ask console and tooltip the person had go at once, every beat plays, no window, dialog, notice or toast opens, and all come back on stop", async () => {
    // First run done or not (the start card's case), and no encryption: the add sheet, Settings and the lock card could
    // all be shown here. The second round is Cortex Desktop, whose Settings is a page of its own (app.setting, branded).
    for (const [firstRunDone, desktop] of [[true, false], [false, true]] as const) {
      const h = fakeServices((x) => void (x.general.firstRunDone = firstRunDone));
      // A loaded record, so the beats that need one (the fly-through and the picks) play too.
      Object.defineProperty(h.services.index, "index", { value: signal(buildSampleIndex(7, Date.UTC(2026, 10, 10))), configurable: true });
      const w = fakeWindowShell();
      const store = h.leaf.store;
      A.openPage(store, "sources", { tab: "files" });
      A.openPopover(store, "display");
      store.update("ui", (u) => ({ ...u, command: { ...u.command, mode: "ask", text: "what changed", consoleOpen: true, consolePinned: true } }));
      store.update("hover", () => ({ ordinal: 3, x: 40, y: 50 }));
      // The shape bar's own panel (the S breakpoint's) is open too: the shell holds it, not the store.
      w.shell.shapeOpen.value = true;
      const before = JSON.stringify(store.snapshot());
      const base = store.get("view");
      const app = h.services.app as unknown as { workspace: { on(n: string, cb: (...a: unknown[]) => void): unknown }; setting?: unknown };
      const settings: unknown[] = [];
      app.workspace.on(SETTINGS_WINDOW_EVENT, (section) => void settings.push(section));
      app.workspace.on("cortex:settings-section", (section) => void settings.push(section));
      const page = { branded: desktop, open: vi.fn(), openTabById: vi.fn() };
      app.setting = page;
      const notices = Notice.all.length;
      // What played: the fly-through's path past real points, the picks, the lens and the charts (on the figure; a page would show as page:<route>).
      const played = new Set<string>();
      stageBus(h.services.bus).on("camera:move", (e) => void (e.legs.some((l) => typeof l.at === "object") && played.add("fly")));
      const offs = [
        store.slices.selection.subscribe((sel) => void (sel && played.add("picks"))),
        store.slices.ui.subscribe((ui) => {
          const top = ui.sheet.open ? ui.sheet.stack[ui.sheet.index] : undefined;
          if (top?.kind === "page") played.add(`page:${top.route}`);
          if (ui.preview?.kind === "area") played.add("lens");
        }),
        store.slices.view.subscribe((v) => void (v.shape === "chart" && played.add("chart"))),
      ];
      const dialogs = vi.spyOn(Modal.prototype, "open");
      try {
        expect(startShowcase(h.services, h.leaf, w.shell)).toBe(true);
        played.clear();
        expectFigureAndChartsOnly(store, "the first step", base, w.shell);
        for (let ms = 100; ms <= 120_000; ms += 100) {
          await vi.advanceTimersByTimeAsync(100);
          expectFigureAndChartsOnly(store, `${ms} ms`, base, w.shell);
          // A toast that comes up while it runs (the frame-rate governor's) waits.
          if (ms === 60_000) w.shell.toast({ kind: "info", text: "lowered detail", sticky: false });
        }
        expect([...played].sort()).toEqual(["chart", "fly", "lens", "picks"]);
        expect(settings).toEqual([]);
        expect(page.open).not.toHaveBeenCalled();
        expect(page.openTabById).not.toHaveBeenCalled();
        expect(dialogs).not.toHaveBeenCalled();
        expect(Notice.all.length).toBe(notices);
        expect(appLocked.value).toBe(false);
        w.press("x");
        expect(JSON.stringify(store.snapshot())).toBe(before);
        expect(w.shell.shapeOpen.value).toBe(true);
        // The toast that waited shows now.
        expect(w.shell.toasts.value.map((x) => x.text)).toEqual(["lowered detail"]);
      } finally {
        dialogs.mockRestore();
        for (const off of offs) off();
        stopShowcase(w.shell);
      }
    }
  });

  it("tours a record that finishes loading while it runs: the steps that need one join in from then on", async () => {
    const h = fakeServices();
    const index = signal<DataIndex | null>(null);
    Object.defineProperty(h.services.index, "index", { value: index, configurable: true });
    const { shell } = fakeWindowShell();
    const counts: number[] = [];
    const needsRecord: ShowcaseStep = { id: "needs", beat: "picks", tempo: "burst", hold: 300, available: (c) => c.count > 0, run: (c) => void counts.push(c.count) };
    const always: ShowcaseStep = { id: "always", beat: "orbit", tempo: "burst", hold: 300, run: () => undefined };
    expect(startShowcase(h.services, h.leaf, shell, () => [needsRecord, always])).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(counts).toEqual([]);
    index.value = buildSampleIndex(7, Date.UTC(2026, 10, 10));
    await vi.advanceTimersByTimeAsync(2000);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts[0]).toBe(index.value?.count);
    stopShowcase(shell);
  });

  it("puts the shape bar's own panel away as it starts (at S, a panel over the stage), keeps it shut, and opens it again on stop", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    h.leaf.store.update("ui", { breakpoint: "S" });
    w.shell.shapeOpen.value = true;
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    expect(w.shell.shapeOpen.value).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    // Anything that opens it meanwhile: shut again at once.
    w.shell.shapeOpen.value = true;
    expect(w.shell.shapeOpen.value).toBe(false);
    w.press("x");
    expect(w.shell.shapeOpen.value).toBe(true);
    // A person who had it shut: it stays shut.
    w.shell.shapeOpen.value = false;
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    w.press("x");
    expect(w.shell.shapeOpen.value).toBe(false);
  });

  it("puts away a menu the person had open as it starts (More, with Settings and Lock): menus live outside the view, and the chord fires with one open", async () => {
    class Key {
      constructor(
        readonly type: string,
        readonly init: { key: string },
      ) {}
    }
    const menus: { name: string; isConnected: boolean; classList: { contains(c: string): boolean }; dispatchEvent(e: Key): boolean; remove(): void }[] = [];
    const escaped: { name: string; driving: boolean }[] = [];
    const menu = (name: string) => {
      const m = {
        name,
        isConnected: true,
        classList: { contains: () => false },
        dispatchEvent: (e: Key) => {
          escaped.push({ name, driving: tourIsDriving() });
          if (e.init.key === "Escape") menus.splice(menus.indexOf(m), 1);
          return true;
        },
        remove: () => void menus.splice(menus.indexOf(m), 1),
      };
      menus.push(m);
    };
    menu("more");
    menu("more › Layout");
    const h = fakeServices();
    const store = h.leaf.store;
    const before = JSON.stringify(store.snapshot());
    const w = fakeWindowShell(undefined, { page: { querySelectorAll: (sel) => (sel === ".menu" ? [...menus] : []) }, win: { KeyboardEvent: Key } });
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    // Closed with Esc, the one on top first (the submenu before its parent), as the tour's own keys.
    expect(menus).toEqual([]);
    expect(escaped).toEqual([
      { name: "more › Layout", driving: true },
      { name: "more", driving: true },
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    w.press("x");
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it("keeps Obsidian's page preview off while it runs (Ctrl + hover as the chord was pressed, or one that comes up just after), and lets it be on stop", async () => {
    const observers: { target: unknown; cb: (records: { addedNodes: unknown[] }[]) => void; live: boolean }[] = [];
    class MO {
      private readonly entry: (typeof observers)[number];
      constructor(cb: (records: { addedNodes: unknown[] }[]) => void) {
        this.entry = { target: null, cb, live: false };
        observers.push(this.entry);
      }
      observe(target: unknown): void {
        this.entry.target = target;
        this.entry.live = true;
      }
      disconnect(): void {
        this.entry.live = false;
      }
    }
    // Obsidian's page preview: <div class="popover hover-popover"> in the document's body.
    const preview = () => fakeStyled("hover-popover");
    const up = preview();
    const body = { inBody: true };
    const h = fakeServices();
    const w = fakeWindowShell(undefined, { page: { querySelectorAll: chosen([up]), body }, win: { MutationObserver: MO } });
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    expect(up.style.getPropertyValue("visibility")).toBe("hidden");
    // Obsidian puts a preview up a moment later (its own wait): hidden as it lands in the body.
    const late = preview();
    const onBody = observers.find((o) => o.target === body && o.live);
    expect(onBody).toBeDefined();
    onBody?.cb([{ addedNodes: [late] }]);
    expect(late.style.getPropertyValue("visibility")).toBe("hidden");
    await vi.advanceTimersByTimeAsync(2000);
    w.press("x");
    expect(observers.every((o) => !o.live)).toBe(true);
    for (const el of [up, late]) expect(el.style.getPropertyValue("visibility")).toBe("");
  });

  it("keeps an error card off, in a page too, and shows every error toast that came up meanwhile once it ends", async () => {
    const h = fakeServices();
    const inPage = fakeStyled("cx-error-card", true);
    const w = fakeWindowShell(undefined, { dom: { querySelectorAll: chosen([inPage]) } });
    w.shell.toast({ id: "mine", kind: "error", text: pendingCopy("sheetFailed"), sticky: true });
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    expect(inPage.style.getPropertyValue("visibility")).toBe("hidden");
    await vi.advanceTimersByTimeAsync(2000);
    w.shell.toast({ kind: "error", text: "background error", sticky: true });
    w.press("x");
    expect(inPage.style.getPropertyValue("visibility")).toBe("");
    // The person's own (up before the tour) and the one that waited both show.
    expect(w.shell.toasts.value.map((x) => x.id === "mine" || x.text)).toEqual([true, "background error"]);
  });

  it("holds every hotkey while it runs, so the key that stops it does nothing else (Cortex Desktop's keymap listens on the window, ahead of the tour)", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    // Cortex Desktop's keymap with the view's scope (ui/keymap.ts: Ctrl+Z undoes the last change).
    const keymap = new Keymap(new DesktopScope());
    const view = new DesktopScope();
    keymap.viewScope = () => view;
    (h.services.app as unknown as { keymap: Keymap }).keymap = keymap;
    const detach = keymap.attach(w.shell.win);
    const offKeys = registerKeymap(view as unknown as Scope, { services: h.services, leaf: h.leaf, shell: w.shell });
    const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const undoKey = { ctrlKey: !mac, metaKey: mac };
    try {
      // Without the tour: Ctrl+Z runs the view's undo.
      const first = vi.fn();
      w.shell.pushUndo(first);
      w.press("z", undoKey);
      expect(first).toHaveBeenCalledTimes(1);
      const undone = vi.fn();
      w.shell.pushUndo(undone);
      expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      // A modifier alone neither stops it nor runs anything.
      w.press("Control", { ctrlKey: true });
      expect(showcaseRunning(w.shell)).toBe(true);
      const stopper = w.press("z", undoKey);
      expect(showcaseRunning(w.shell)).toBe(false);
      expect(undone).not.toHaveBeenCalled();
      expect(stopper.ev.defaultPrevented).toBe(true);
      expect(stopper.stopped).toBe(true);
      // The hotkeys are the view's again once it has stopped.
      w.press("z", undoKey);
      expect(undone).toHaveBeenCalledTimes(1);
    } finally {
      offKeys();
      detach();
      stopShowcase(w.shell);
    }
  });

  it("still stops on any key where the keymap also keeps a key it took from the document, and no hotkey runs there either", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    // A keymap on the window that, having taken a key, keeps it from the page altogether.
    const stack: { handleKey(e: KeyboardEvent): boolean }[] = [];
    const view = new DesktopScope();
    const offKeys = registerKeymap(view as unknown as Scope, { services: h.services, leaf: h.leaf, shell: w.shell });
    (h.services.app as unknown as { keymap: unknown }).keymap = {
      pushScope: (s: never) => void stack.push(s),
      popScope: (s: never) => void stack.splice(stack.indexOf(s), 1),
    };
    (w.shell.win as unknown as { addEventListener(n: string, f: (e: KeyboardEvent) => void): void }).addEventListener("keydown", (e) => {
      if (!(stack.at(-1) ?? view).handleKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
    });
    const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    try {
      const undone = vi.fn();
      w.shell.pushUndo(undone);
      expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      const stopper = w.press("z", { ctrlKey: !mac, metaKey: mac });
      expect(stopper.stopped).toBe(true);
      expect(undone).not.toHaveBeenCalled();
      // The tour's own listener never saw that key: it stops a moment later all the same, and puts everything back.
      await vi.advanceTimersByTimeAsync(1);
      expect(showcaseRunning(w.shell)).toBe(false);
      expect(stack).toEqual([]);
      expect(undone).not.toHaveBeenCalled();
    } finally {
      offKeys();
      stopShowcase(w.shell);
    }
  });

  it("the wheel that stops it zooms nothing: neither it nor the rest of its gesture reaches the stage, and a camera waiting for its layout keeps waiting", async () => {
    const groupsCut: ShowcaseStep = { id: "cut", beat: "groups", tempo: "normal", hold: 500, run: (c) => void c.store.update("view", { shape: "groups", groupBy: "month", layout: "wheel" }) };
    // Nothing to lay out again: the pose goes back at once, and the wheel never reaches the canvas to zoom it after.
    {
      const h = fakeServices();
      const w = fakeWindowShell();
      const seen: string[] = [];
      h.services.bus.on("camera:restore", () => void seen.push("restore"));
      const still: ShowcaseStep = { id: "still", beat: "orbit", tempo: "hold", hold: 1200, run: (c) => c.camera([{ at: "brain", distance: 0.3, ms: 900 }]) };
      expect(startShowcase(h.services, h.leaf, w.shell, [still])).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      const stopper = w.wheel();
      expect(showcaseRunning(w.shell)).toBe(false);
      expect(seen).toEqual(["restore"]);
      expect(stopper.stopped).toBe(true);
      expect(stopper.ev.preventDefault).toHaveBeenCalled();
      expect(w.reached("wheel")).toBe(0);
    }
    // The person on a chart: the pose waits for the chart's layout. The gesture's tail (a trackpad's glide) neither zooms
    // nor hands the camera back early; once the wheel rests, the next wheel is the person's own.
    {
      const h = fakeServices();
      const w = fakeWindowShell();
      A.setView(h.leaf.store, "chart", { chart: "matrix", x: { dim: "space", sort: "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} });
      A.setShape(h.leaf.store, "chart");
      const seen: string[] = [];
      h.services.bus.on("camera:restore", () => void seen.push("restore"));
      expect(startShowcase(h.services, h.leaf, w.shell, [groupsCut])).toBe(true);
      await vi.advanceTimersByTimeAsync(450);
      expect(w.wheel().stopped).toBe(true);
      expect(showcaseRunning(w.shell)).toBe(false);
      for (let k = 0; k < 6; k++) {
        await vi.advanceTimersByTimeAsync(40);
        const tail = w.wheel();
        expect(tail.stopped, `tail ${k}`).toBe(true);
        expect(tail.ev.preventDefault, `tail ${k}`).toHaveBeenCalled();
      }
      expect(w.reached("wheel")).toBe(0);
      expect(seen).toEqual([]);
      h.services.bus.emit("layout:arrangement", { viewId: h.leaf.viewId, kind: "chart" });
      expect(seen).toEqual(["restore"]);
      await vi.advanceTimersByTimeAsync(300);
      expect(w.wheel().stopped).toBe(false);
      expect(w.reached("wheel")).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.listeners()).toBe(0);
    }
  });

  it("the press that stops it does nothing else: its release, click and menu never reach the stage (which takes a bare release for a click)", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    const store = h.leaf.store;
    A.select(store, 4, "e_4");
    const before = JSON.stringify(store.snapshot());
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    // A right press, held a while: the release and the context menu (Windows sends it after the release) are kept back.
    expect(w.click({ button: 2 }).stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    for (const name of ["pointerup", "mouseup", "contextmenu", "auxclick"]) expect(w.fire(name).stopped, name).toBe(true);
    for (const name of ["pointerup", "pointerdown", "click", "contextmenu"]) expect(w.reached(name), name).toBe(0);
    expect(JSON.stringify(store.snapshot())).toBe(before);
    // Then the person's next press is theirs.
    await vi.advanceTimersByTimeAsync(400);
    expect(w.listeners()).toBe(0);
    expect(w.click().stopped).toBe(false);
    expect(w.fire("pointerup").stopped).toBe(false);
    expect(w.reached("pointerup")).toBe(1);
  });

  it("keeps toasts back while it runs and shows them, the ones already up included, when it ends", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    w.shell.toast({ id: "before", kind: "info", text: "already up" });
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    expect(w.shell.toasts.value).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    w.shell.toast({ kind: "error", text: "background error" });
    w.shell.toast({ id: "before", kind: "info", text: "already up, again" });
    expect(w.shell.toasts.value).toEqual([]);
    stopShowcase(w.shell);
    expect(w.shell.toasts.value.map((x) => x.text)).toEqual(["background error", "already up, again"]);
  });

  it("ends at once when the lock comes up (Lock now or the idle auto-lock), and puts the view back under it", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    const store = h.leaf.store;
    const before = JSON.stringify(store.snapshot());
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    appLocked.value = true;
    expect(showcaseRunning(w.shell)).toBe(false);
    expect(JSON.stringify(store.snapshot())).toBe(before);
    // Typing into the lock card's passphrase field is not taken for the tour's stop key.
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.listeners()).toBe(0);
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it("does not start while a dialog is open, ends when one opens, and the command tries once more after a closing one", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    const store = h.leaf.store;
    const person = store.get("view");
    w.dialog(true);
    expect(modalOpen(w.shell.doc)).toBe(true);
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(false);
    // The command palette's own prompt on its way out: the command starts the tour once it has gone.
    toggleShowcase(h.services, h.leaf, w.shell);
    expect(showcaseRunning(w.shell)).toBe(false);
    w.dialog(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(showcaseRunning(w.shell)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.get("view")).not.toBe(person);
    // Settings, a confirm or any other dialog opening mid-tour: the tour ends and the view comes back.
    w.dialog(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(showcaseRunning(w.shell)).toBe(false);
    expect(store.get("view")).toBe(person);
    // And the command does not start it behind a dialog that stays.
    toggleShowcase(h.services, h.leaf, w.shell);
    await vi.advanceTimersByTimeAsync(1000);
    expect(showcaseRunning(w.shell)).toBe(false);
  });

  it("runs one tour at a time across views", async () => {
    const h = fakeServices();
    const a = fakeWindowShell(undefined, { viewId: "a" });
    const b = fakeWindowShell(undefined, { viewId: "b" });
    const other = h.services.createLeaf("b");
    expect(startShowcase(h.services, h.leaf, a.shell, buildShowcase(ENV, 2))).toBe(true);
    expect(anyShowcaseRunning()).toBe(true);
    expect(startShowcase(h.services, other, b.shell, buildShowcase(ENV, 2))).toBe(false);
    stopShowcase(a.shell);
    expect(anyShowcaseRunning()).toBe(false);
    expect(startShowcase(h.services, other, b.shell, buildShowcase(ENV, 2))).toBe(true);
    stopShowcase(b.shell);
  });

  it("keeps the pointer from raising a tooltip or a preview over the view, and lets go of one that was up", async () => {
    const h = fakeServices();
    const w = fakeWindowShell();
    const store = h.leaf.store;
    store.update("hover", () => ({ ordinal: 5, x: 10, y: 10 }));
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    expect(store.get("hover")).toBeNull();
    // A move over the view stops before it reaches the canvas; one elsewhere in the window goes on.
    expect(w.move().stopped).toBe(true);
    expect(w.move({ elsewhere: true }).stopped).toBe(false);
    // Whatever sets a hover meanwhile is let go at once.
    store.update("hover", () => ({ ordinal: 6, x: 12, y: 12 }));
    expect(store.get("hover")).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    stopShowcase(w.shell);
    expect(w.move().stopped).toBe(false);
    store.update("hover", () => ({ ordinal: 6, x: 12, y: 12 }));
    expect(store.get("hover")).not.toBeNull();
  });

  it("keeps exactly these off the screen, each a class its component really renders", () => {
    // Pinned: dropping one (the start card, the Add sources banner, the toasts) fails here, not only on screen.
    const renderedBy: Record<string, string> = {
      ".cx-banner": "src/ui/stage/Banner.tsx",
      ".cx-first-run": "src/ui/stage/FirstRunCard.tsx",
      ".cx-tour-layer": "src/ui/walkthrough/TourLayer.tsx",
      ".cx-hint": "src/ui/stage/Hints.tsx",
      ".cx-richness": "src/ui/stage/Hints.tsx",
      ".cx-toasts": "src/ui/stage/Toasts.tsx",
      ".cx-tooltip": "src/ui/stage/Tooltip.tsx",
      ".cx-member-card": "src/ui/stage/MemberCard.tsx",
      ".cx-arranging": "src/ui/stage/LoadingLines.tsx",
      ".cx-console": "src/ui/command/AskConsole.tsx",
      ".cx-find-results": "src/ui/command/FindResults.tsx",
      ".cx-popover": "src/ui/primitives/controls.tsx",
      ".cx-error-card": "src/ui/pages/PageFrame.tsx",
    };
    const list = (s: string) => s.split(",").map((x) => x.trim());
    expect(list(MUTED_OVERLAYS)).toEqual([".cx-banner", ".cx-first-run", ".cx-tour-layer", ".cx-hint", ".cx-richness", ".cx-toasts", ".cx-tooltip", ".cx-member-card", ".cx-arranging", ".cx-console", ".cx-find-results", ".cx-popover"]);
    expect(list(MUTED_ANYWHERE)).toEqual([".cx-error-card"]);
    // Obsidian's own page preview (its class, not Cortex's).
    expect(list(MUTED_IN_PAGE)).toEqual([".hover-popover"]);
    for (const sel of [...list(MUTED_OVERLAYS), ...list(MUTED_ANYWHERE)]) {
      const file = renderedBy[sel];
      expect(file, sel).toBeDefined();
      const source = readFileSync(path.resolve(__dirname, "..", file as string), "utf8");
      // In a class attribute: the class itself, not one that only starts with it (cx-hint, not cx-hint-text).
      expect(source, sel).toMatch(new RegExp(`class=\\{?["'\`](?:[^"'\`]*\\s)?${sel.slice(1)}(?=["'\`\\s$])`));
    }
    // The shape bar's panel at S, the full key and the strip's period form are popovers too.
    for (const [file, cls] of [["src/ui/stage/ShapeBar.tsx", "cx-shape-popover"], ["src/ui/strip/PeriodPopover.tsx", "cx-popover cx-period-popover"]] as const) {
      expect(readFileSync(path.resolve(__dirname, "..", file), "utf8"), file).toContain(cls);
    }
  });

  it("hides the start card, banners, hints, the walkthrough, the coverage note, toasts, tooltips and panels in place while it runs, each exactly as it was after", async () => {
    const h = fakeServices();
    // Named here, not read from the list: each must be hidden by the list as it stands.
    const classes = ["cx-banner", "cx-first-run", "cx-tour-layer", "cx-hint", "cx-richness", "cx-toasts", "cx-tooltip", "cx-member-card", "cx-arranging", "cx-console", "cx-find-results", "cx-popover"];
    const made = classes.map((c) => fakeStyled(c));
    // One was already hidden by its own inline style; it keeps that.
    made[1]?.style.setProperty("visibility", "collapse");
    const inSheet = fakeStyled("cx-hint", true);
    const w = fakeWindowShell(undefined, { dom: { querySelectorAll: chosen([...made, inSheet]) } });
    expect(startShowcase(h.services, h.leaf, w.shell, buildShowcase(ENV, 2))).toBe(true);
    for (const el of made) expect(el.style.getPropertyValue("visibility"), el.cls).toBe("hidden");
    for (const el of made) expect(el.style.getPropertyPriority("visibility"), el.cls).toBe("important");
    // The sheet holds the Chart card or the Time page: nothing in it is touched.
    expect(inSheet.style.getPropertyValue("visibility")).toBe("");
    // A host that drew one over it again: the next step hides it again.
    made[0]?.style.removeProperty("visibility");
    await vi.advanceTimersByTimeAsync(2000);
    expect(made[0]?.style.getPropertyValue("visibility")).toBe("hidden");
    stopShowcase(w.shell);
    expect(made[1]?.style.getPropertyValue("visibility")).toBe("collapse");
    for (const el of made.filter((_, i) => i !== 1)) expect(el.style.getPropertyValue("visibility"), el.cls).toBe("");
  });

  it("puts a space's own colour look back on stop, as the person had it", async () => {
    const space: UserSpace = { id: "work", name: "Work", areas: ["claude-code" as SpaceId, "vault" as SpaceId], folders: [], theme: "sapphire", palette: "harbor", open: true };
    const h = fakeServices((x) => void (x.userSpaces = [space]));
    const w = fakeWindowShell();
    const store = h.leaf.store;
    store.update("ui", (u) => ({ ...u, scope: "all", tokens: userSpaceTokens(space) }));
    expect(store.get("ui").tokens.every((tk) => tk.id.startsWith(USER_SPACE_TOKEN_PREFIX))).toBe(true);
    // The space's look, shown through the settings preview as the wordmark's sync shows it.
    h.services.settings.preview?.((x) => {
      x.appearance.figureColours = "sapphire";
      x.appearance.palette = "harbor";
    });
    const steps = buildShowcase(showcaseEnv(h.services), 2).filter((s) => s.beat === "colours");
    expect(startShowcase(h.services, h.leaf, w.shell, steps)).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    stopShowcase(w.shell);
    expect(h.services.settings.value.appearance.figureColours).toBe("sapphire");
    expect(h.services.settings.value.appearance.palette).toBe("harbor");
    expect(h.saved).toHaveLength(0);
    // The space still chosen but its look already ended (a real settings change since): the stored colours are what come back.
    h.services.settings.endPreview?.();
    const stored = h.services.settings.value;
    expect(startShowcase(h.services, h.leaf, w.shell, steps)).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    stopShowcase(w.shell);
    expect(h.services.settings.value).toBe(stored);
  });

  it("previews colours on the figure only without saving, and the stored settings come back on stop", async () => {
    const h = fakeServices();
    const { shell, press } = fakeWindowShell();
    const own = h.services.settings.value.appearance.palette;
    const steps = buildShowcase(showcaseEnv(h.services), 2).filter((s) => s.beat === "colours");
    expect(startShowcase(h.services, h.leaf, shell, steps)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.services.settings.value.appearance.figureColours).not.toBeNull();
    expect(h.services.settings.value.appearance.palette).toBe(own);
    press("x");
    expect(h.services.settings.value.appearance.figureColours).toBeNull();
    expect(h.services.settings.value.appearance.palette).toBe(own);
    expect(h.saved).toHaveLength(0);
  });
});

// ───────────────────────────── the window drivers (duck-typed DOM) ─────────────────────────────

/** Does a selector list (".a, .b") pick out an element of class `cls`? Class selectors only, which is all the mute uses. */
function selects(selector: string, cls: string): boolean {
  return selector.split(",").some((s) => s.trim() === `.${cls}`);
}

/** A querySelectorAll over these elements that answers as a browser would for a list of class selectors. */
function chosen<T extends { cls: string }>(els: readonly T[]): (sel: string) => T[] {
  return (sel) => els.filter((e) => selects(sel, e.cls));
}

/** An element with a real-enough inline style (the overlay mute reads and writes `visibility` on it) and a class it matches by. */
function fakeStyled(cls: string, inSheet = false): { cls: string; nodeType: number; isConnected: boolean; style: CSSStyleDeclaration; closest(sel: string): unknown; matches(sel: string): boolean } {
  const props = new Map<string, { value: string; priority: string }>();
  const style = {
    getPropertyValue: (p: string) => props.get(p)?.value ?? "",
    getPropertyPriority: (p: string) => props.get(p)?.priority ?? "",
    setProperty: (p: string, value: string, priority = "") => void props.set(p, { value, priority }),
    removeProperty: (p: string) => {
      const was = props.get(p)?.value ?? "";
      props.delete(p);
      return was;
    },
  } as unknown as CSSStyleDeclaration;
  return { cls, nodeType: 1, isConnected: true, style, closest: (sel: string) => (inSheet && sel === ".cx-sheet" ? {} : null), matches: (sel: string) => selects(sel, cls) };
}

class FakeEl {
  readonly cls = new Set<string>();
  readonly children: FakeEl[] = [];
  text = "";
  clicked = 0;
  onClick: (() => void) | null = null;
  constructor(classes: string[] = [], text = "") {
    for (const c of classes) this.cls.add(c);
    this.text = text;
  }
  get textContent(): string {
    return this.text;
  }
  classList = {
    contains: (c: string) => this.cls.has(c),
    toggle: (c: string, on: boolean) => void (on ? this.cls.add(c) : this.cls.delete(c)),
  };
  click(): void {
    this.clicked++;
    this.onClick?.();
  }
}

describe("the window drivers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("finds the menus open in the document, not one fading out", () => {
    const menu = new FakeEl(["menu"]);
    const fading = new FakeEl(["menu", "is-leaving"]);
    expect(openMenus({ querySelectorAll: () => [menu, fading] } as unknown as Document)).toEqual([menu]);
    expect(openMenus(null)).toEqual([]);
  });

  it("closes a menu the tour left open with Esc, so it hides itself and gives the keyboard back, and takes off what is left", () => {
    class Key {
      constructor(
        readonly type: string,
        readonly init: { key: string },
      ) {}
    }
    const removed: string[] = [];
    const hidden: string[] = [];
    const keys: { key: string; driving: boolean }[] = [];
    const menus: { name: string; classList: { contains(c: string): boolean }; dispatchEvent(e: Key): boolean; remove(): void }[] = [];
    const menu = (name: string, hidesOnEscape: boolean, leaving = false) => {
      const m = {
        name,
        classList: { contains: (c: string) => leaving && c === "is-leaving" },
        dispatchEvent: (e: Key) => {
          keys.push({ key: e.init.key, driving: tourIsDriving() });
          if (hidesOnEscape && e.type === "keydown" && e.init.key === "Escape") {
            hidden.push(name);
            menus.splice(menus.indexOf(m), 1);
          }
          return true;
        },
        remove: () => {
          removed.push(name);
          menus.splice(menus.indexOf(m), 1);
        },
      };
      menus.push(m);
    };
    menu("picker", true);
    menu("stuck", false);
    menu("fading", true, true);
    const doc = { defaultView: { KeyboardEvent: Key }, querySelectorAll: () => [...menus] } as unknown as Document;
    closeMenus(doc);
    // The open menus get Esc (marked as the tour's own key); the one already fading out is left to finish.
    expect(keys).toEqual([
      { key: "Escape", driving: true },
      { key: "Escape", driving: true },
    ]);
    expect(hidden).toEqual(["picker"]);
    expect(removed).toEqual(["stuck"]);
    expect(menus.map((m) => m.name)).toEqual(["fading"]);
    // A host without a keyboard event (or a menu without dispatch): the menus are taken off the page as before.
    const bare: string[] = [];
    closeMenus({ querySelectorAll: () => [{ classList: { contains: () => false }, remove: () => void bare.push("a") }, { classList: { contains: () => false }, remove: () => void bare.push("b") }] } as unknown as Document);
    expect(bare).toEqual(["a", "b"]);
  });

  it("hides overlays added while the tour runs, leaves the sheet alone, and puts every inline style back", () => {
    let observed: ((records: { addedNodes: unknown[] }[]) => void) | null = null;
    class MO {
      constructor(cb: (records: { addedNodes: unknown[] }[]) => void) {
        observed = cb;
      }
      observe(): void {}
      disconnect(): void {
        observed = null;
      }
    }
    const toast = fakeStyled("cx-toasts");
    const root = {
      ownerDocument: { defaultView: { MutationObserver: MO } },
      querySelectorAll: chosen([toast]),
    } as unknown as HTMLElement;
    const mute = muteOverlays(root);
    expect(toast.style.getPropertyValue("visibility")).toBe("hidden");
    // A banner and a hint come up: hidden as they arrive (the hint by its own class, the banner inside a new subtree).
    const banner = fakeStyled("cx-banner");
    const hint = fakeStyled("cx-hint");
    const wrapper = { nodeType: 1, matches: () => false, querySelectorAll: chosen([banner]) };
    (observed as unknown as (r: { addedNodes: unknown[] }[]) => void)([{ addedNodes: [hint, wrapper, { nodeType: 3 }] }]);
    expect(hint.style.getPropertyValue("visibility")).toBe("hidden");
    expect(banner.style.getPropertyValue("visibility")).toBe("hidden");
    mute.release();
    expect(observed).toBeNull();
    for (const el of [toast, banner, hint]) expect(el.style.getPropertyValue("visibility")).toBe("");
  });

  it("gives the chord to the view the keyboard is in, never to one behind a dialog, and with the focus outside every view to the one last focused", () => {
    const view = (id: string, active: unknown = null) => {
      const shell = new Shell(id);
      const doc = { activeElement: active };
      const root = { isConnected: true, ownerDocument: doc, getClientRects: () => [{}], contains: () => false };
      shell.root = root as unknown as HTMLElement;
      return shell;
    };
    const inDialog = { closest: (sel: string) => (sel === ".modal-container" ? {} : null) };
    expect(leafOwnsKeys(view("a", inDialog))).toBe(false);
    const onPage = { closest: () => null };
    // Nothing known about the last focused view: any view on screen takes it (one tour at a time sorts the rest).
    expect(leafOwnsKeys(view("a", onPage))).toBe(true);
    expect(leafOwnsKeys(view("a", onPage), "a")).toBe(true);
    // Another view was focused last, and it is not one that is on screen now (no such view): this one takes it.
    expect(leafOwnsKeys(view("a", onPage), "gone")).toBe(true);
    // The view focused last is on screen: it takes the chord, not this one (two tours would start at once otherwise).
    adoptShell({ viewId: "b" } as unknown as LeafServices, view("b"));
    expect(leafOwnsKeys(view("a", onPage), "b")).toBe(false);
    const inMine = view("a");
    (inMine.doc as unknown as { activeElement: unknown }).activeElement = { closest: (sel: string) => (sel === ".cx-root" ? inMine.root : null) };
    expect(leafOwnsKeys(inMine, "b")).toBe(true);
  });

  it("tilts the window with a perspective transform and takes every trace of it off again", () => {
    const style: Record<string, string> = { transform: "scale(1)", transition: "opacity 1s", willChange: "opacity", transformOrigin: "10% 10%" };
    const el = { style } as unknown as HTMLElement;
    const memory = rememberTilt(el);
    tiltWindow(el, { rx: 3, ry: -4, scale: 1.05, ms: 1500 });
    expect(style.transform).toMatch(/perspective\(\d+px\) rotateX\(3deg\) rotateY\(-4deg\) scale\(1\.05\)/);
    expect(style.transition).toContain("1500ms");
    tiltWindow(el, null);
    expect(style.transform).toMatch(/rotateX\(0deg\) rotateY\(0deg\) scale\(1\)/);
    restoreTilt(el, memory);
    expect(style).toEqual({ transform: "scale(1)", transition: "opacity 1s", willChange: "opacity", transformOrigin: "10% 10%" });
  });
});
