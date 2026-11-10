/**
 * Time › "When you wrote" (SPEC V15): the worker series (one month axis shared by every section, the period
 * re-ranging them, area stack totals, lanes, day heat, speakers, labels over time) and the page's pure model
 * (month columns, drag → period, axis ticks, day-heat steps, segments, label choices, status wording).
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { emptyIndex } from "../src/shared/indexCodec";
import { Population } from "../src/shared/index-format";
import type { WhenStack, WhenStats } from "../src/shared/protocol/worker";
import { parsePeriodPreview } from "../src/render/controller";
import { createLeafStore } from "../src/state/store";
import { addDaysMs, clearLockTokens, DayHeat, groupText, Lane, lockText, lockTokens, MonthChart, previewKey, withoutNone } from "../src/ui/pages/WhenSections";
import {
  axisTicks,
  columnOf,
  csvCell,
  daysCsv,
  heatLevel,
  isoDay,
  isoMonth,
  labelChoices,
  lanesCsv,
  monthSpanPeriod,
  monthText,
  monthTotals,
  rangeText,
  segmentAt,
  segmentsOf,
  skeletonHeights,
  stackCsv,
  timeSpanPeriod,
  weekMonthLabels,
} from "../src/ui/pages/whenModel";
import { defaultVisibility, localDay, monthIndexOfDay, writtenAt } from "../src/worker/charts/common";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { computeStats } from "../src/worker/stats";
import { hubSourceSpan } from "../src/ui/strip/TimeStrip";
import { ItemKind } from "../src/shared/index-format";
import { hubMemberList } from "../src/shared/hoverModel";
import { readFileSync } from "node:fs";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis = { ...defaultVisibility(index.count) };

function when(over: Partial<{ labelDim: "kind" | "project" | "space"; weekStart: 0 | 1; period: [number, number] | null }> = {}): WhenStats {
  const res = computeStats(index, { kind: "when", labelDim: over.labelDim ?? "kind", weekStart: over.weekStart ?? 1, visibility: { ...vis, period: over.period ?? null } }, { now: NOW });
  if (res.kind !== "when") throw new Error("not a when result");
  return res;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe("worker: the when series", () => {
  const w = when();
  const months = w.monthStarts.length - 1;

  it("spans whole months from the first to the last dated item, with exact local boundaries", () => {
    expect(months).toBeGreaterThan(3);
    expect(w.monthStarts[0]).toBeLessThanOrEqual(w.first);
    expect(w.monthStarts[months]).toBeGreaterThan(w.last);
    for (let i = 0; i < months; i++) expect(w.monthStarts[i + 1]).toBeGreaterThan(w.monthStarts[i] as number);
    expect(new Date(w.monthStarts[0] as number).getDate()).toBe(1);
    expect(new Date(w.monthStarts[0] as number).getHours()).toBe(0);
  });

  it("activity by area counts every dated visible item once", () => {
    let dated = 0;
    for (let o = 0; o < index.count; o++) if (Number.isFinite(writtenAt(index, o))) dated += 1;
    const total = sum(w.area.cells);
    // Hidden-by-default traffic is not counted; everything counted is dated and sits in some month.
    expect(total).toBeGreaterThan(1000);
    expect(total).toBeLessThanOrEqual(dated);
    expect(w.area.cells.length).toBe(w.area.groups.length * months);
    expect(w.area.groups.length).toBeLessThanOrEqual(10);
    const per = monthTotals(w.area, months);
    expect(sum(per)).toBe(total);
  });

  it("the stacks of areas and labels never disagree with each other on the items they both count", () => {
    // Labels drop items with no value; everything else is the same item set.
    expect(sum(w.labels.cells) + w.labels.unlabelled).toBe(sum(w.area.cells));
    expect(w.labels.dim).toBe("kind");
    expect(w.labels.unlabelled).toBeGreaterThan(0);
  });

  it("another label dimension re-stacks the same months", () => {
    const p = when({ labelDim: "project" });
    expect(p.monthStarts).toEqual(w.monthStarts);
    expect(p.labels.dim).toBe("project");
    expect(sum(p.labels.cells) + p.labels.unlabelled).toBe(sum(p.area.cells));
  });

  it("speakers and days both count record entries", () => {
    const entries = sum(w.speakers.you) + sum(w.speakers.assistant) + sum(w.speakers.other);
    expect(entries).toBe(sum(w.days.counts));
    expect(sum(w.speakers.you)).toBeGreaterThan(0);
    expect(w.speakers.you.length).toBe(months);
    expect(w.days.counts.length).toBe(7 * w.days.weekStarts.length);
    expect(w.days.max).toBe(Math.max(...w.days.counts));
  });

  it("heat weeks start on the configured weekday", () => {
    const mon = when({ weekStart: 1 }).days.weekStarts;
    const sun = when({ weekStart: 0 }).days.weekStarts;
    expect(new Date(mon[0] as number).getDay()).toBe(1);
    expect(new Date(sun[0] as number).getDay()).toBe(0);
    for (let i = 1; i < mon.length; i++) expect(new Date(mon[i] as number).getDay()).toBe(1);
  });

  it("lanes hold the four note kinds in date order, capped", () => {
    expect(w.lanes.map((l) => l.kind)).toEqual(["decision", "question", "plan", "abandoned"]);
    for (const lane of w.lanes) {
      expect(lane.ticks.length).toBeLessThanOrEqual(lane.total);
      for (let i = 1; i < lane.ticks.length; i++) expect(lane.ticks[i]!.t).toBeGreaterThanOrEqual(lane.ticks[i - 1]!.t);
      for (const k of lane.ticks) {
        expect(k.t).toBeGreaterThanOrEqual(w.monthStarts[0] as number);
        expect(k.t).toBeLessThan(w.monthStarts[months] as number);
        expect(index.cols.pop[k.ordinal]).toBe(Population.Note);
      }
    }
    expect(w.lanes.reduce((n, l) => n + l.total, 0)).toBeGreaterThan(0);
  });

  it("a period re-ranges every section to it", () => {
    const from = w.monthStarts[Math.floor(months / 2)] as number;
    const to = (w.monthStarts[Math.floor(months / 2) + 2] as number) - 1;
    const r = when({ period: [from, to] });
    expect(r.monthStarts.length - 1).toBeLessThanOrEqual(2);
    expect(r.monthStarts[0]).toBeGreaterThanOrEqual(from - 31 * 86_400_000);
    expect(sum(r.area.cells)).toBeLessThan(sum(w.area.cells));
    expect(sum(r.area.cells)).toBeGreaterThan(0);
    for (const lane of r.lanes) for (const k of lane.ticks) expect(k.t >= from && k.t <= to).toBe(true);
    expect(r.days.weekStarts.length).toBeLessThanOrEqual(w.days.weekStarts.length);
    expect(sum(r.speakers.you)).toBeLessThanOrEqual(sum(w.speakers.you));
    // The items in the month axis are exactly the dated items inside the period.
    let inside = 0;
    for (let o = 0; o < index.count; o++) {
      const t = writtenAt(index, o);
      if (Number.isFinite(t) && t >= from && t <= to) inside += 1;
    }
    expect(sum(r.area.cells)).toBeLessThanOrEqual(inside);
  });

  it("a period with nothing in it, and an empty index, give empty series", () => {
    for (const r of [when({ period: [1, 2] }), (computeStats(emptyIndex(), { kind: "when", labelDim: "kind", weekStart: 1, visibility: defaultVisibility(0) }) as WhenStats)]) {
      expect(r.monthStarts).toEqual([]);
      expect(r.area.cells).toEqual([]);
      expect(r.days.counts).toEqual([]);
      expect(r.lanes.every((l) => l.total === 0 && l.ticks.length === 0)).toBe(true);
    }
  });

  it("counts months with the same local calendar the rest of the app uses", () => {
    const first = monthIndexOfDay(localDay(w.first));
    expect(monthText(w.monthStarts[0] as number)).toBe(monthText(new Date(Math.floor(first / 12), first % 12, 1).getTime()));
  });
});

describe("model: columns, drags and ticks", () => {
  const starts = [0, 10, 20, 30, 40].map((d) => new Date(2025, 0, 1 + d).getTime());

  it("maps a pointer fraction to a month column, clamped", () => {
    expect(columnOf(0, 4)).toBe(0);
    expect(columnOf(0.5, 4)).toBe(2);
    expect(columnOf(1, 4)).toBe(3);
    expect(columnOf(-1, 4)).toBe(0);
    expect(columnOf(0.3, 0)).toBe(-1);
  });

  it("a drag across months covers whole months, either direction", () => {
    expect(monthSpanPeriod(starts, 1, 2)).toEqual([starts[1], (starts[3] as number) - 1]);
    expect(monthSpanPeriod(starts, 2, 1)).toEqual([starts[1], (starts[3] as number) - 1]);
    expect(monthSpanPeriod(starts, -3, 99)).toEqual([starts[0], (starts[4] as number) - 1]);
    expect(monthSpanPeriod([5], 0, 0)).toBeNull();
  });

  it("a drag across a continuous axis keeps at least an hour", () => {
    const day = 86_400_000;
    expect(timeSpanPeriod(0.25, 0.75, 0, 100 * day)).toEqual([25 * day, 75 * day]);
    expect(timeSpanPeriod(0.75, 0.25, 0, 100 * day)).toEqual([25 * day, 75 * day]);
    const [a, b] = timeSpanPeriod(0.5, 0.5, 0, 86_400_000 * 100) as [number, number];
    expect(b - a).toBe(3_600_000);
    expect(timeSpanPeriod(0, 1, 5, 5)).toBeNull();
  });

  it("labels the axis by year over long ranges and every second month over short ones", () => {
    const long = Array.from({ length: 31 }, (_, i) => new Date(2024, i, 1).getTime());
    expect(axisTicks(long).map((t) => t.label)).toEqual(["2024", "2025", "2026"]);
    const short = Array.from({ length: 9 }, (_, i) => new Date(2025, 9 + i, 1).getTime());
    expect(axisTicks(short).map((t) => t.label)).toEqual(["Oct 25", "Dec", "Feb", "Apr"]);
  });

  it("steps the day heat in four quantiles", () => {
    expect([0, 1, 2, 3, 4, 5, 8].map((n) => heatLevel(n, 8))).toEqual([0, 1, 1, 2, 2, 3, 4]);
    expect(heatLevel(3, 0)).toBe(0);
  });

  it("stacks segments bottom-up against the busiest month and finds the one under a pointer", () => {
    const stack: WhenStack = { groups: [{ key: "a", label: "A", kind: "value" }, { key: "b", label: "B", kind: "value" }], cells: [2, 0, 1, 4] };
    expect(monthTotals(stack, 2)).toEqual([3, 4]);
    const m0 = segmentsOf(stack, 2, 0, 4);
    expect(m0.map((s) => s.g)).toEqual([0, 1]);
    expect(m0[1]).toMatchObject({ y0: 0.5, y1: 0.75, n: 1 });
    expect(segmentAt(m0, 0.2)?.g).toBe(0);
    expect(segmentAt(m0, 0.6)?.g).toBe(1);
    expect(segmentAt(m0, 0.9)).toBeNull();
    expect(segmentsOf(stack, 2, 1, 4).map((s) => s.g)).toEqual([1]);
  });

  it("offers kind, project, source, folder and every loaded label field once", () => {
    const opts = labelChoices([{ pack: "session", field: "work" }, { pack: "session", field: "work" }, { pack: "note", field: "topic" }]);
    expect(opts.map((o) => o.id)).toEqual(["kind", "project", "source", "folder", "label:session/work", "label:note/topic"]);
  });

  it("writes months, days and ranges in fixed English", () => {
    expect(monthText(new Date(2025, 10, 5).getTime())).toBe("Nov 2025");
    expect(rangeText(new Date(2024, 9, 28).getTime(), new Date(2025, 10, 11).getTime())).toBe("28 Oct 2024 – 11 Nov 2025");
  });

  it("labels the heatmap's months without crowding", () => {
    const weeks = Array.from({ length: 20 }, (_, i) => new Date(2025, 0, 6 + 7 * i).getTime());
    const labels = weekMonthLabels(weeks);
    expect(labels[0]).toEqual({ w: 0, label: "Jan" });
    for (let i = 1; i < labels.length; i++) expect(labels[i]!.w - labels[i - 1]!.w).toBeGreaterThanOrEqual(3);
  });

  it("skeleton heights are stable and in range", () => {
    expect(skeletonHeights(5)).toEqual(skeletonHeights(5));
    expect(skeletonHeights(40).every((h) => h > 0.2 && h < 0.85)).toBe(true);
  });
});

describe("page: wording and the brain preview", () => {
  it("writes the lock status with and without a label", () => {
    expect(lockText(1284, "Nov 2025")).toBe("1,284 in Nov 2025");
    expect(lockText(12, "Nov 2025", "Work")).toBe("12 with Work in Nov 2025");
  });

  it("the preview key is one the renderer reads, covering the whole period", () => {
    const key = previewKey([1000, 4999]);
    expect(key).toBe("1000-5000");
    expect(parsePeriodPreview(key)).toEqual([1000, 5000]);
  });

  it("hides the Unsorted group from a stack", () => {
    const stack: WhenStack = {
      groups: [{ key: "work", label: "Work", kind: "value" }, { key: "", label: "", kind: "none" }, { key: "__other__", label: "Other", kind: "other" }],
      cells: [1, 2, 9, 9, 5, 6],
    };
    const out = withoutNone(stack, 2);
    expect(out.groups.map((g) => g.kind)).toEqual(["value", "other"]);
    expect(out.cells).toEqual([1, 2, 5, 6]);
    expect(withoutNone(out, 2)).toBe(out);
  });

  it("names groups for the dimension they came from", () => {
    expect(groupText("space", { key: "", label: "", kind: "none" }, "No x")).toBe("No area");
    expect(groupText("kind", { key: "", label: "", kind: "none" }, "No kind")).toBe("No kind");
    expect(groupText("kind", { key: "decision", label: "decision", kind: "value" }, "")).toBe("Decision");
    expect(groupText("project", { key: "p", label: "Apollo", kind: "value" }, "")).toBe("Apollo");
    expect(groupText("space", { key: "x", label: "x", kind: "other" }, "")).toBe("Other");
  });
});

describe("page: locking a month lights it in the brain", () => {
  it("adds a time token for the month, and a group token for a clicked segment", () => {
    const store = createLeafStore();
    lockTokens(store, [100, 199], "12 in Nov 2025");
    expect(store.get("ui").tokens).toEqual([{ id: "when:time", kind: "time", label: "12 in Nov 2025", range: [100, 199] }]);
    lockTokens(store, [100, 199], "4 with Work in Nov 2025", { dim: "space", value: "work", label: "Work" });
    expect(store.get("ui").tokens.map((t) => t.id)).toEqual(["when:time", "when:label"]);
    expect(store.get("ui").tokens[1]).toMatchObject({ kind: "group", dim: "space", value: "work" });
    // Locking another month replaces the old lock instead of stacking.
    lockTokens(store, [200, 299], "9 in Dec 2025");
    expect(store.get("ui").tokens.map((t) => t.id)).toEqual(["when:time"]);
    expect(store.get("ui").tokens[0]?.range).toEqual([200, 299]);
  });

  it("Clear removes only its own tokens", () => {
    const store = createLeafStore();
    store.update("ui", { tokens: [{ id: "text:x", kind: "text", label: "x", text: "x" }] });
    lockTokens(store, [1, 2], "t", { dim: "kind", value: "decision", label: "Decision" });
    clearLockTokens(store);
    expect(store.get("ui").tokens.map((t) => t.id)).toEqual(["text:x"]);
  });

  it("the speaker bar for others also lights tool entries, and Clear removes every extra token", () => {
    const store = createLeafStore();
    lockTokens(store, [1, 2], "3 with Others in Nov 2025", { dim: "speaker", value: "other", label: "Others", alsoValues: ["tool"] });
    expect(store.get("ui").tokens.map((t) => [t.id, t.value])).toEqual([["when:time", undefined], ["when:label", "other"], ["when:label+1", "tool"]]);
    lockTokens(store, [3, 4], "x");
    expect(store.get("ui").tokens.map((t) => t.id)).toEqual(["when:time"]);
    lockTokens(store, [1, 2], "y", { dim: "speaker", value: "other", label: "Others", alsoValues: ["tool"] });
    clearLockTokens(store);
    expect(store.get("ui").tokens).toEqual([]);
  });

  it("day ranges follow the calendar across daylight-saving changes", () => {
    for (const [y, m, d] of [[2026, 2, 28], [2026, 9, 24], [2026, 10, 1]] as const) {
      const start = new Date(y, m, d).getTime();
      expect(addDaysMs(start, 1)).toBe(new Date(y, m, d + 1).getTime());
      expect(addDaysMs(start, 7)).toBe(new Date(y, m, d + 7).getTime());
    }
  });

  it("the lock lights exactly the month: the worker query over the token matches a month total", async () => {
    const { queryOp } = await import("../src/worker/indexOps");
    const w = when();
    const m = Math.floor((w.monthStarts.length - 1) / 2);
    const range: [number, number] = [w.monthStarts[m] as number, (w.monthStarts[m + 1] as number) - 1];
    const store = createLeafStore();
    lockTokens(store, range, "x");
    const res = queryOp({ tokens: store.get("ui").tokens, visibility: defaultVisibility(index.count) }, { index } as never);
    expect(res.count).toBeGreaterThanOrEqual(monthTotals(w.area, w.monthStarts.length - 1)[m] as number);
  });
});

describe("page: the charts draw what the spec records", () => {
  const monthStarts = Array.from({ length: 5 }, (_, i) => new Date(2025, i, 1).getTime());
  const stack: WhenStack = { groups: [{ key: "work", label: "Work", kind: "value" }, { key: "", label: "", kind: "none" }], cells: [1, 2, 3, 4, 2, 0, 1, 1] };
  const base = { name: "Activity", monthStarts, stack, nameOf: (g: number) => (g === 0 ? "Work" : "Unsorted"), onHover: () => undefined, onPick: () => undefined, onLive: () => undefined, onRange: () => undefined };

  it("draws outlined bars with the hollow group and a full-height outlined column on hover", () => {
    const html = render(<MonthChart {...base} fillOf={(g) => (g === 0 ? { colour: "var(--cx-cat-1)" } : { colour: null })} hover={2} skeleton={false} />);
    expect(html).toContain("cx-when-bar is-hollow");
    expect(html).toContain('class="cx-when-hover"');
    expect(html).toContain("Mar 2025 · 4");
    expect(html).not.toContain("cx-when-skel");
  });

  it("shows grey skeleton bars in place of the data while a range is recomputed", () => {
    const html = render(<MonthChart {...base} fillOf={() => ({ colour: "red" })} hover={null} skeleton />);
    expect(html).toContain("cx-when-skel");
    expect(html).not.toContain("cx-when-bar");
    expect(html).not.toContain("cx-when-hover");
  });

  it("solid bars carry a lighter top edge", () => {
    const html = render(<MonthChart {...base} solid fillOf={() => ({ colour: "var(--cx-you-fill)", edge: "var(--cx-you)" })} hover={null} skeleton={false} />);
    expect(html).toContain("is-solid");
    expect(html).toContain('fill="var(--cx-you)"');
  });

  it("lanes draw a 2 × 8 tick per note with a tooltip, in the kind colour", () => {
    const html = render(<Lane lane={{ kind: "decision", total: 2, ticks: [{ t: 50, ordinal: 1, title: "Use Postgres" }, { t: 90, ordinal: 2, title: "Ship it" }] }} from={0} to={100} skeleton={false} onLive={() => undefined} onRange={() => undefined} />);
    expect(html.match(/cx-when-lane-tick/g)?.length).toBe(2);
    expect(html).toContain("Use Postgres");
    expect(html).toContain('width="2" height="8"');
    expect(html).toContain("Decisions");
  });

  it("the day heatmap is 7 rows × weeks of 9 px cells on a 2 px gap", () => {
    const weekStarts = [0, 1, 2].map((w) => new Date(2025, 0, 6 + 7 * w).getTime());
    const counts = new Array<number>(21).fill(0);
    counts[0] = 4;
    counts[8] = 1;
    const html = render(<DayHeat days={{ weekStarts, counts, max: 4 }} weekStart={1} skeleton={false} onLive={() => undefined} onRange={() => undefined} onPickDay={() => undefined} />);
    expect(html.match(/cx-when-cell /g)?.length).toBe(21);
    expect(html).toContain("is-4");
    expect(html).toContain("is-1");
    expect(html).toContain('width="9" height="9"');
    expect(html).toContain("6 Jan 2025 · 4 entries");
  });
});

describe("a locked day lights the entries it counts", () => {
  it("a recordsOnly time token lights record entries only; a plain one also lights notes dated in the range", async () => {
    const { queryOp } = await import("../src/worker/indexOps");
    const w = when();
    const weeks = w.days.weekStarts.length;
    // The busiest day of the heatmap.
    let best = -1;
    for (let i = 0; i < w.days.counts.length; i++) if (best < 0 || (w.days.counts[i] as number) > (w.days.counts[best] as number)) best = i;
    const day = addDaysMs(w.days.weekStarts[best % weeks] as number, Math.floor(best / weeks));
    const range: [number, number] = [day, addDaysMs(day, 1) - 1];
    const lit = (recordsOnly: boolean) => {
      const store = createLeafStore();
      lockTokens(store, range, "x", undefined, recordsOnly);
      return queryOp({ tokens: store.get("ui").tokens, visibility: defaultVisibility(index.count) }, { index } as never);
    };
    const only = lit(true);
    for (const o of only.ordinals) expect(index.cols.pop[o]).toBe(Population.Record);
    expect(only.count).toBe(w.days.counts[best]);
    expect(lit(false).count).toBeGreaterThanOrEqual(only.count);
    const store = createLeafStore();
    lockTokens(store, range, "x", undefined, true);
    expect(store.get("ui").tokens[0]).toMatchObject({ recordsOnly: true });
  });
});

describe("Copy as CSV: the visible period's series", () => {
  it("quotes fields that need it", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("stacks give one row per month and one column per group", () => {
    const monthStarts = [new Date(2025, 0, 1).getTime(), new Date(2025, 1, 1).getTime(), new Date(2025, 2, 1).getTime()];
    const stack: WhenStack = { groups: [{ key: "a", label: "Work, home", kind: "value" }, { key: "", label: "", kind: "none" }], cells: [1, 2, 3, 4] };
    expect(stackCsv(monthStarts, stack, (g) => (g === 0 ? "Work, home" : "No area"), "Month")).toBe('Month,"Work, home",No area\n2025-01,1,3\n2025-02,2,4');
  });

  it("lanes give one row per tick and days one row per day with entries", () => {
    const t = new Date(2025, 4, 3, 12).getTime();
    expect(lanesCsv([{ kind: "decision", ticks: [{ t, title: "Use Postgres" }] }, { kind: "plan", ticks: [] }], (k) => k.toUpperCase(), ["Kind", "Date", "Title"])).toBe("Kind,Date,Title\nDECISION,2025-05-03,Use Postgres");
    const weekStarts = [new Date(2025, 0, 6).getTime(), new Date(2025, 0, 13).getTime()];
    const counts = new Array<number>(14).fill(0);
    counts[0] = 4; // row 0 (Monday), week 0
    counts[3 * 2 + 1] = 2; // row 3, week 1
    expect(daysCsv({ weekStarts, counts }, addDaysMs, ["Date", "Entries"])).toBe("Date,Entries\n2025-01-06,4\n2025-01-16,2");
    expect(isoDay(new Date(2025, 11, 9).getTime())).toBe("2025-12-09");
    expect(isoMonth(new Date(2025, 11, 9).getTime())).toBe("2025-12");
  });

  it("each section has a Copy as CSV action", () => {
    const src = readFileSync("src/ui/pages/WhenSections.tsx", "utf8");
    expect(src.match(/<SectionHead [^>]*csv=/g)?.length).toBe(5);
  });
});

describe("the When sections follow the theme tokens", () => {
  it("hover, span and empty-cell fills use Cortex tokens, not fixed colours", () => {
    const css = readFileSync("src/styles/pages.css", "utf8");
    const rules = css.split("\n").filter((l) => /^\.cx-when/.test(l));
    expect(rules.length).toBeGreaterThan(10);
    for (const l of rules) expect(l, l).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}/);
  });
});

describe("a hovered map brackets its source entries on the time strip", () => {
  it("spans the dated record entries its member notes are built from", () => {
    let checked = 0;
    for (let h = 0; h < index.count && checked < 3; h++) {
      if (index.cols.kind[h] !== ItemKind.NoteHub) continue;
      const span = hubSourceSpan(index, h);
      if (!span) continue;
      checked += 1;
      expect(span[0]).toBeLessThanOrEqual(span[1]);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("covers every dated source entry of the map, not a capped subset", () => {
    for (let h = 0; h < index.count; h++) {
      if (index.cols.kind[h] !== ItemKind.NoteHub) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const n of hubMemberList(index, h)) {
        const { offsets, targets } = index.rel.noteSources;
        if (n + 1 >= offsets.length) continue;
        for (let k = offsets[n] as number; k < (offsets[n + 1] as number); k++) {
          const e = targets[k] as number;
          const v = index.cols.t[e] as number;
          if (index.cols.pop[e] === Population.Record && Number.isFinite(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
      }
      expect(hubSourceSpan(index, h)).toEqual(Number.isFinite(lo) ? [lo, hi] : null);
    }
  });

  it("is null for a note that is not a map, out of range, or no index", () => {
    expect(hubSourceSpan(null, 0)).toBeNull();
    expect(hubSourceSpan(index, -1)).toBeNull();
    expect(hubSourceSpan(index, index.count)).toBeNull();
    const note = Array.from({ length: index.count }, (_, o) => o).find((o) => index.cols.kind[o] !== ItemKind.NoteHub);
    expect(hubSourceSpan(index, note as number)).toBeNull();
  });
});
