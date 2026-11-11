import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTRA_SECTIONS, extraRows, isExtraSection, registerSectionRows, renderExtraRows, type SectionHost, type SectionRow } from "../src/plugin/settingsSections";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

const host = {} as SectionHost;
const row = (id: string, section: SectionRow["section"], extra: Partial<SectionRow> = {}): SectionRow => ({ id, section, render: () => undefined, ...extra });
const undo: (() => void)[] = [];
const add = (...rows: SectionRow[]) => undo.push(registerSectionRows(rows));
afterEach(() => {
  while (undo.length) undo.pop()?.();
});

describe("settings section hook", () => {
  it("covers the six tabs the packages extend", () => {
    expect([...EXTRA_SECTIONS].sort()).toEqual(["advanced", "agents", "capture", "general", "lock", "privacy"]);
    expect(isExtraSection("lock")).toBe(true);
    expect(isExtraSection("appearance")).toBe(false);
  });

  it("draws nothing for a section no feature registered rows for (features add their own providers)", () => {
    expect(extraRows("no-such-section")).toEqual([]);
    for (const s of EXTRA_SECTIONS) for (const r of extraRows(s)) expect(r.section).toBe(s);
    const spy = vi.fn();
    renderExtraRows(host, "no-such-section", DEFAULT_SETTINGS, spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it("draws a section's rows in order, then id, and only that section", () => {
    const calls: string[] = [];
    const r = (id: string, section: SectionRow["section"], order?: number): SectionRow => row(id, section, { order, render: () => void calls.push(id) });
    add(r("b", "lock"), r("a", "lock"), r("first", "lock", 1), r("p", "privacy"), r("late", "lock", 500));
    renderExtraRows(host, "lock", DEFAULT_SETTINGS);
    expect(calls).toEqual(["first", "a", "b", "late"]);
  });

  it("skips rows whose condition is false and passes settings and host through", () => {
    const seen: unknown[] = [];
    add(
      row("hidden", "agents", { when: () => false, render: () => void seen.push("hidden") }),
      row("shown", "agents", { when: (s) => s === DEFAULT_SETTINGS, render: (h, s) => void seen.push([h === host, s === DEFAULT_SETTINGS]) }),
    );
    renderExtraRows(host, "agents", DEFAULT_SETTINGS);
    expect(seen).toEqual([[true, true]]);
  });

  it("a failing row is reported and the others still draw", () => {
    const calls: string[] = [];
    const errors: string[] = [];
    add(
      row("bad", "capture", {
        order: 1,
        render: () => {
          throw new Error("x");
        },
      }),
      row("ok", "capture", { order: 2, render: () => void calls.push("ok") }),
    );
    renderExtraRows(host, "capture", DEFAULT_SETTINGS, (id) => errors.push(id));
    expect(errors).toEqual(["bad"]);
    expect(calls).toEqual(["ok"]);
  });

  it("ignores sections it does not extend and removes registered rows again", () => {
    const calls: string[] = [];
    const off = registerSectionRows([row("x", "general", { render: () => void calls.push("x") })]);
    renderExtraRows(host, "appearance", DEFAULT_SETTINGS);
    expect(calls).toEqual([]);
    renderExtraRows(host, "general", DEFAULT_SETTINGS);
    off();
    renderExtraRows(host, "general", DEFAULT_SETTINGS);
    expect(calls).toEqual(["x"]);
  });
});
