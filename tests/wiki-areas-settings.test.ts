/**
 * Settings › Sources › Wiki folders and their areas: the pure edits, the rows drawn from a fake settings host with the copy
 * from copy.ts, and where the settings tab draws them (inside This vault's notes, after Folders to skip).
 */
import { Setting } from "obsidian";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type CortexSettings, type SettingsIssue } from "../src/shared/settings";
import { AREA_IDS, WIKI_AREA_LIMITS, sanitiseWikiAreas } from "../src/shared/spaces";
import { checkPatched } from "../src/plugin/settingsStore";
import { CortexSettingTab } from "../src/plugin/settingsTab";
import type { SectionHost } from "../src/plugin/settingsSections";
import { addWikiArea, areaOptions, removeWikiArea, renderWikiAreas, setWikiAreaArea, setWikiAreaFolder } from "../src/plugin/settingsSections/wikiAreasSection";
import { SETTINGS_COPY } from "../src/ui/copy";
import { fakeServices } from "./helpers/fakeServices";

const c = SETTINGS_COPY.wikiAreas;
const draft = (): CortexSettings => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CortexSettings;
const label = (n: number, total: number): string => c.rowLabel.replace("{n}", String(n)).replace("{total}", String(total));

describe("the edits", () => {
  it("add a row with a tidy folder, and refuse an empty, repeated or extra one", () => {
    const s = draft();
    expect(addWikiArea(s, "  notes\\recipes/ ", "life")).toBe("added");
    expect(s.wikiAreas).toEqual([{ folder: "notes/recipes", area: "life" }]);
    expect(addWikiArea(s, "/notes/recipes", "code")).toBe("taken");
    expect(addWikiArea(s, " / ", "code")).toBe("missing");
    expect(addWikiArea(s, "work", "money")).toBe("added");
    expect(s.wikiAreas.map((r) => r.folder)).toEqual(["notes/recipes", "work"]);
  });

  it("stop at the limit", () => {
    const s = draft();
    for (let i = 0; i < WIKI_AREA_LIMITS.rows; i++) expect(addWikiArea(s, `f${i}`, "web")).toBe("added");
    expect(addWikiArea(s, "one-more", "web")).toBe("full");
    expect(s.wikiAreas).toHaveLength(WIKI_AREA_LIMITS.rows);
  });

  it("edit a row's folder and area in place", () => {
    const s = draft();
    addWikiArea(s, "notes", "life");
    addWikiArea(s, "work", "money");
    setWikiAreaFolder(s, 0, " notes/baking/ ");
    setWikiAreaArea(s, 0, "games");
    expect(s.wikiAreas[0]).toEqual({ folder: "notes/baking", area: "games" });
  });

  it("keep a row as it was while its folder is retyped, would repeat another row's, or names no area", () => {
    const s = draft();
    addWikiArea(s, "notes", "life");
    addWikiArea(s, "work", "money");
    setWikiAreaFolder(s, 0, "");
    setWikiAreaFolder(s, 0, "/work/");
    setWikiAreaArea(s, 0, "none");
    setWikiAreaArea(s, 0, "Money");
    setWikiAreaFolder(s, 7, "x");
    setWikiAreaArea(s, 7, "web");
    expect(s.wikiAreas).toEqual([
      { folder: "notes", area: "life" },
      { folder: "work", area: "money" },
    ]);
  });

  it("remove a row, and nothing for a row that is not there", () => {
    const s = draft();
    addWikiArea(s, "notes", "life");
    addWikiArea(s, "work", "money");
    removeWikiArea(s, 5);
    removeWikiArea(s, -1);
    removeWikiArea(s, 0);
    expect(s.wikiAreas).toEqual([{ folder: "work", area: "money" }]);
  });

  it("write only rows the settings validator keeps unchanged, so a save is never refused", () => {
    const s = draft();
    addWikiArea(s, " a\\b ", "ai");
    addWikiArea(s, "c/", "vault");
    setWikiAreaFolder(s, 1, "/c/d//");
    setWikiAreaArea(s, 0, "design");
    const issues: SettingsIssue[] = [];
    expect(sanitiseWikiAreas(JSON.parse(JSON.stringify(s.wikiAreas)), issues)).toEqual(s.wikiAreas);
    expect(issues).toEqual([]);
    expect(checkPatched(s).wikiAreas).toEqual([
      { folder: "a/b", area: "design" },
      { folder: "c/d", area: "vault" },
    ]);
  });

  it("offer the ten areas by name, in their order", () => {
    const o = areaOptions();
    expect(Object.keys(o)).toEqual([...AREA_IDS]);
    expect(o.money).toBe("Money");
    expect(o.vault).toBe("Vault");
    expect("none" in o).toBe(false);
  });
});

// ───────────────────────────── the rows, from a fake host ─────────────────────────────

interface Ctl {
  value: string;
  placeholder?: string;
  options?: Record<string, string>;
  aria?: string;
  change: (v: string) => void;
}
interface Row {
  name: string;
  desc?: string;
  texts: Ctl[];
  dropdowns: Ctl[];
  removes: { tooltip: string; click: () => void }[];
  buttons: { text: string; cta: boolean; click: () => void }[];
}

function fakeHost() {
  const rows: Row[] = [];
  const headings: { name: string; desc?: string }[] = [];
  const notes: string[] = [];
  const notices: string[] = [];
  const patches: ((s: CortexSettings) => void)[] = [];
  let refreshes = 0;
  const host = {
    mount: { createEl: (_tag: string, o: { text?: string }) => void notes.push(o.text ?? "") },
    desktopHost: false,
    set: (p: (s: CortexSettings) => void) => void patches.push(p),
    refresh: () => void refreshes++,
    notify: (t: string) => void notices.push(t),
    heading: (name: string, desc?: string) => void headings.push(desc === undefined ? { name } : { name, desc }),
    row: (name: string, desc?: string) => {
      const row: Row = { name, ...(desc === undefined ? {} : { desc }), texts: [], dropdowns: [], removes: [], buttons: [] };
      rows.push(row);
      const chain: Record<string, unknown> = {};
      chain.addText = (cb: (t: unknown) => void) => {
        const ctl: Ctl = { value: "", change: () => undefined };
        row.texts.push(ctl);
        const t: Record<string, unknown> = {
          inputEl: { setAttribute: (_k: string, v: string) => void (ctl.aria = v) },
          setValue: (v: string) => ((ctl.value = v), t),
          setPlaceholder: (p: string) => ((ctl.placeholder = p), t),
          onChange: (f: (v: string) => void) => ((ctl.change = f), t),
        };
        cb(t);
        return chain;
      };
      chain.addDropdown = (cb: (d: unknown) => void) => {
        const ctl: Ctl = { value: "", options: {}, change: () => undefined };
        row.dropdowns.push(ctl);
        const d: Record<string, unknown> = {
          selectEl: { setAttribute: (_k: string, v: string) => void (ctl.aria = v) },
          addOptions: (o: Record<string, string>) => ((ctl.options = { ...ctl.options, ...o }), d),
          setValue: (v: string) => ((ctl.value = v), d),
          onChange: (f: (v: string) => void) => ((ctl.change = f), d),
        };
        cb(d);
        return chain;
      };
      chain.addExtraButton = (cb: (b: unknown) => void) => {
        const btn = { tooltip: "", click: () => undefined as void };
        row.removes.push(btn);
        const b: Record<string, unknown> = {
          setIcon: () => b,
          setTooltip: (t: string) => ((btn.tooltip = t), b),
          onClick: (f: () => void) => ((btn.click = f), b),
        };
        cb(b);
        return chain;
      };
      chain.addButton = (cb: (b: unknown) => void) => {
        const btn = { text: "", cta: false, click: () => undefined as void };
        row.buttons.push(btn);
        const b: Record<string, unknown> = {
          setButtonText: (t: string) => ((btn.text = t), b),
          setCta: () => ((btn.cta = true), b),
          onClick: (f: () => void) => ((btn.click = f), b),
        };
        cb(b);
        return chain;
      };
      return chain;
    },
    toggle: () => undefined,
    dropdown: () => undefined,
    text: () => undefined,
    slider: () => undefined,
    services: () => Promise.reject(new Error("no services in this test")),
  } as unknown as SectionHost;
  /** The settings after every change the rows asked for, applied in order to `base`. */
  const applied = (base: CortexSettings): CortexSettings => {
    const s = JSON.parse(JSON.stringify(base)) as CortexSettings;
    for (const p of patches) p(s);
    return s;
  };
  return { host, rows, headings, notes, notices, patches, applied, refreshes: () => refreshes };
}

const withRows = (...pairs: [string, CortexSettings["wikiAreas"][number]["area"]][]): CortexSettings => {
  const s = draft();
  s.wikiAreas = pairs.map(([folder, area]) => ({ folder, area }));
  return s;
};

describe("the rows", () => {
  it("with none: the heading and its description, the empty line, then the row that adds one", () => {
    const f = fakeHost();
    renderWikiAreas(f.host, draft());
    expect(f.headings).toEqual([{ name: c.heading, desc: c.headingDesc }]);
    expect(f.notes).toEqual([c.empty]);
    expect(f.rows.map((r) => r.name)).toEqual([c.add]);
    const add = f.rows[0]!;
    expect(add.desc).toBe(c.addDesc);
    expect(add.texts[0]).toMatchObject({ value: "", placeholder: c.folderPlaceholder, aria: c.folder });
    expect(add.dropdowns[0]).toMatchObject({ value: AREA_IDS[0], options: areaOptions(), aria: c.area });
    expect(add.buttons.map((b) => [b.text, b.cta])).toEqual([[c.addButton, true]]);
  });

  it("one row per folder: its path to edit, its area to choose, and Remove", () => {
    const base = withRows(["notes", "life"], ["work", "money"]);
    const f = fakeHost();
    renderWikiAreas(f.host, base);
    expect(f.notes).toEqual([]);
    expect(f.rows.map((r) => r.name)).toEqual([label(1, 2), label(2, 2), c.add]);
    expect(label(1, 2)).toBe("Folder 1 of 2");
    const [first, second] = f.rows;
    expect(first!.texts[0]).toMatchObject({ value: "notes", placeholder: c.folderPlaceholder, aria: c.folder });
    expect(first!.dropdowns[0]).toMatchObject({ value: "life", options: areaOptions(), aria: c.area });
    expect(second!.removes.map((r) => r.tooltip)).toEqual([c.remove]);
    second!.texts[0]!.change("work/clients/");
    first!.dropdowns[0]!.change("design");
    expect(f.applied(base).wikiAreas).toEqual([
      { folder: "notes", area: "design" },
      { folder: "work/clients", area: "money" },
    ]);
    // Typing and choosing save the change without redrawing (the field keeps its focus).
    expect(f.refreshes()).toBe(0);
    first!.removes[0]!.click();
    expect(f.applied(base).wikiAreas).toEqual([{ folder: "work/clients", area: "money" }]);
    expect(f.refreshes()).toBe(1);
  });

  it("Add takes the typed folder and the chosen area", () => {
    const base = withRows(["notes", "life"]);
    const f = fakeHost();
    renderWikiAreas(f.host, base);
    const add = f.rows.find((r) => r.name === c.add)!;
    add.texts[0]!.change(" \\projects\\site\\ ");
    add.dropdowns[0]!.change("web");
    add.buttons[0]!.click();
    expect(f.notices).toEqual([]);
    expect(f.applied(base).wikiAreas).toEqual([
      { folder: "notes", area: "life" },
      { folder: "projects/site", area: "web" },
    ]);
    expect(f.refreshes()).toBe(1);
  });

  it("Add says why when there is no folder, or the folder already has a row, and changes nothing", () => {
    const base = withRows(["notes", "life"]);
    const f = fakeHost();
    renderWikiAreas(f.host, base);
    const add = f.rows.find((r) => r.name === c.add)!;
    add.buttons[0]!.click();
    expect(f.notices).toEqual([c.missing]);
    expect(f.patches).toEqual([]);
    add.texts[0]!.change("/notes/");
    add.buttons[0]!.click();
    // The saved rows decide (the change runs on them): nothing is added, and the reason is shown.
    expect(f.applied(base).wikiAreas).toEqual(base.wikiAreas);
    expect(f.notices).toEqual([c.missing, c.taken.replace("{folder}", "notes")]);
  });

  it("Add checks the saved rows, not the ones drawn, after a row's folder was edited in place", () => {
    const base = withRows(["notes", "life"]);
    const f = fakeHost();
    renderWikiAreas(f.host, base);
    f.rows[0]!.texts[0]!.change("work");
    const add = f.rows.find((r) => r.name === c.add)!;
    add.texts[0]!.change("notes");
    add.dropdowns[0]!.change("code");
    add.buttons[0]!.click();
    expect(f.applied(base).wikiAreas).toEqual([
      { folder: "work", area: "life" },
      { folder: "notes", area: "code" },
    ]);
    expect(f.notices).toEqual([]);
  });

  it("at the limit: the rows, then the limit instead of the row that adds one", () => {
    const s = draft();
    for (let i = 0; i < WIKI_AREA_LIMITS.rows; i++) addWikiArea(s, `f${i}`, "web");
    const f = fakeHost();
    renderWikiAreas(f.host, s);
    expect(f.rows).toHaveLength(WIKI_AREA_LIMITS.rows);
    expect(f.rows.some((r) => r.name === c.add)).toBe(false);
    expect(f.notes).toEqual([c.limit.replace("{n}", String(WIKI_AREA_LIMITS.rows))]);
  });
});

describe("in the settings tab", () => {
  const created = (Setting as unknown as { created: { name: string; heading: boolean }[] }).created;
  const tab = (patch?: (s: CortexSettings) => void) => {
    const hh = fakeServices(patch);
    return new CortexSettingTab(hh.services.app as never, { plugin: { manifest: { version: "0.1.0" } } as never, settings: () => hh.services.settings, services: () => Promise.reject(new Error("not needed")) });
  };

  it("sits with the vault's notes in Sources (the Live capture tab), right after Folders to skip", () => {
    const t = tab();
    created.length = 0;
    t.section = "capture";
    t.display();
    const names = created.map((x) => x.name);
    const at = names.indexOf(c.heading);
    expect(at).toBeGreaterThan(names.indexOf(SETTINGS_COPY.sources.vault));
    expect(at).toBeGreaterThan(names.indexOf(SETTINGS_COPY.sources.skipFolders));
    expect(at).toBeLessThan(names.indexOf(SETTINGS_COPY.sources.raw));
    expect(created[at]?.heading).toBe(true);
    expect(names.slice(at, at + 2)).toEqual([c.heading, c.add]);
  });

  it("draws your saved rows there", () => {
    const t = tab((s) => void (s.wikiAreas = [{ folder: "notes", area: "life" }]));
    created.length = 0;
    t.section = "capture";
    t.display();
    const names = created.map((x) => x.name);
    expect(names.slice(names.indexOf(c.heading), names.indexOf(c.heading) + 3)).toEqual([c.heading, label(1, 1), c.add]);
  });
});
