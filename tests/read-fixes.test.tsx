/**
 * pkg-01 read fixes: the chosen folder row stays a light bar on Desktop (R-01), list rows carry the message count and
 * a pin glyph (R-02), and Today opens the day's note in the reader column (R-03). The vault is never written: the
 * note is read from a fake vault object, and creating a missing note is only Obsidian's own command.
 */
import { readFileSync } from "node:fs";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { dailyNotePath, formatDailyName, parseDailyOptions } from "../src/shared/dailyNote";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { ReadNav, ReadRowView, type ReadRow } from "../src/ui/pages/Read";
import { canCreateDaily, loadToday, readDailyOptions, TodayNote } from "../src/ui/reader/TodayNote";
import { fakeServices } from "./helpers/fakeServices";

const css = (name: string) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8");

describe("R-01: the chosen row of the folder column on Desktop", () => {
  const fixes = css("desktop-fixes.css");
  const rule = /(^|\n)([^{}\n]*\.cx-nav-row\.is-on[^{}\n]*)\{([^}]*)\}/.exec(fixes);
  const classes = (sel: string) => (sel.match(/\.[\w-]+|:hover|:not\([^)]*\)/g) ?? []).length;

  it("has a rule that fills the chosen row light with dark text, and it outweighs the rail's `background: none`", () => {
    expect(rule).not.toBeNull();
    const body = rule?.[3] ?? "";
    expect(body).toContain("background: var(--cx-text-1)");
    expect(body).toContain("color: var(--cx-chrome)");
    expect(css("desktop-shell.css")).toContain(".cx-root.is-desktop .cx-nav-row:hover { background: none; }");
    // The rail rule weighs 3 classes plus :hover; every selector of ours weighs at least 5.
    for (const sel of (rule?.[2] ?? "").split(",")) expect(classes(sel.trim())).toBeGreaterThanOrEqual(5);
  });

  it("is imported after desktop-shell.css", () => {
    const entry = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(entry.indexOf("desktop-fixes.css")).toBeGreaterThan(entry.indexOf("desktop-shell.css"));
  });

  it("keeps Everything and Pinned above the scrolling Recent and folder block", () => {
    const h = fakeServices();
    const html = render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <ReadNav
            owner={{}}
            tree={[{ path: "Projects", count: 3, depth: 0 }]}
            everything={9}
            pinned={1}
            selection={{ kind: "everything" }}
            width={32}
            recent={[{ ordinal: 1, title: "A chat", count: 4 }]}
            openOrdinal={-1}
            onEverything={() => undefined}
            onPinned={() => undefined}
            onFolder={() => undefined}
            onOpenRecent={() => undefined}
          />
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
    const scroll = html.indexOf("cx-nav-scroll");
    expect(scroll).toBeGreaterThan(0);
    expect(html.indexOf(">Everything<")).toBeLessThan(scroll);
    expect(html.indexOf(">Pinned<")).toBeLessThan(scroll);
    expect(html.indexOf("A chat")).toBeGreaterThan(scroll);
    expect(html.indexOf(">Projects<")).toBeGreaterThan(scroll);
    expect(html).toContain('class="cx-nav-row is-on" role="treeitem" aria-selected="true"');
  });
});

describe("R-02: list rows", () => {
  const row: ReadRow = { ordinal: 0, id: "e_aaaaaaaaaaaaaaaa", title: "Cursor per file", ms: Date.UTC(2026, 10, 3, 12), count: 402, youShare: 0.4, source: "claude-code", space: "code", isMap: false };
  const draw = (pinned: boolean) => {
    const h = fakeServices();
    return render(
      <ServicesContext.Provider value={h.services}>
        <ReadRowView row={row} pinned={pinned} when="2 h" tabbable onOpen={() => undefined} onFocus={() => undefined} />
      </ServicesContext.Provider>,
    );
  };
  it("shows the count at the right of the title line and the age on the second line", () => {
    const html = draw(false);
    const line = html.slice(html.indexOf("cx-read-line"), html.indexOf("cx-snippet"));
    expect(line).toContain("Cursor per file");
    expect(line).toContain(">402<");
    expect(line).not.toContain("2 h");
    expect(html.slice(html.indexOf("cx-snippet"))).toContain("2 h");
    expect(html).toContain('title="402 messages"');
    expect(html).not.toContain("cx-read-pin");
  });
  it("puts a pin glyph before the title of a pinned row", () => {
    const html = draw(true);
    expect(html.indexOf("cx-read-pin")).toBeGreaterThan(0);
    expect(html.indexOf("cx-read-pin")).toBeLessThan(html.indexOf("Cursor per file"));
  });
});

describe("R-03: Today's note", () => {
  const D = new Date(2026, 10, 11);
  it("formats the Daily notes name with moment tokens", () => {
    expect(formatDailyName("YYYY-MM-DD", D)).toBe("2026-11-11");
    expect(formatDailyName("dddd, MMMM Do YYYY", D)).toBe("Wednesday, November 11th 2026");
    expect(formatDailyName("[Day] D.M.YY", D)).toBe("Day 11.11.26");
    expect(formatDailyName("YYYY/MM/DD ddd", new Date(2026, 0, 2))).toBe("2026/01/02 Fri");
  });
  it("builds a vault path from the folder and format, and refuses paths that leave the vault", () => {
    expect(dailyNotePath(parseDailyOptions(undefined), D)).toBe("2026-11-11.md");
    expect(dailyNotePath(parseDailyOptions({ folder: "/Journal/Daily/", format: "YYYY-MM-DD" }), D)).toBe("Journal/Daily/2026-11-11.md");
    expect(dailyNotePath({ folder: "", format: "../YYYY" }, D)).toBeNull();
    expect(parseDailyOptions({ format: "  ", folder: 4 })).toEqual({ format: "YYYY-MM-DD", folder: "" });
  });

  const appWith = (files: Record<string, string>, options?: unknown, settingsFile?: string) =>
    ({
      internalPlugins: options ? { getPluginById: () => ({ instance: { options } }) } : undefined,
      vault: {
        getAbstractFileByPath: (p: string) => (p in files ? { path: p } : null),
        cachedRead: async (f: { path: string }) => files[f.path] ?? "",
        adapter: { read: async (p: string) => (settingsFile !== undefined && p === ".obsidian/daily-notes.json" ? settingsFile : Promise.reject(new Error("none"))) },
      },
    }) as never;

  it("reads the day's note named by Daily notes' live options, then by its settings file, then by the defaults", async () => {
    const live = await loadToday(appWith({ "Journal/2026-11-11.md": "# Plan" }, { folder: "Journal", format: "YYYY-MM-DD" }), false, D);
    expect(live).toEqual({ kind: "note", path: "Journal/2026-11-11.md", text: "# Plan" });
    expect(await readDailyOptions(appWith({}, undefined, JSON.stringify({ folder: "Days", format: "YYYY-MM-DD" })))).toEqual({ folder: "Days", format: "YYYY-MM-DD" });
    expect(await readDailyOptions(appWith({}))).toEqual({ folder: "", format: "YYYY-MM-DD" });
    expect(await loadToday(appWith({}), false, D)).toEqual({ kind: "none", path: "2026-11-11.md" });
  });
  it("offers Create only where Obsidian's Daily notes command exists", () => {
    expect(canCreateDaily({ commands: { commands: { "daily-notes": {} } } } as never)).toBe(true);
    expect(canCreateDaily({ commands: { commands: {} } } as never)).toBe(false);
    expect(canCreateDaily({} as never)).toBe(false);
  });
  it("reads nothing in the sample record", async () => {
    expect(await loadToday(appWith({ "2026-11-11.md": "private" }), true, D)).toEqual({ kind: "sample" });
  });
  it("opens with the loading line and the Today's entries link", () => {
    const h = fakeServices();
    const html = render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <TodayNote />
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
    expect(html).toContain(t("nav.todayOpening"));
    expect(html).toContain(t("reader.todayEntries"));
  });
});
