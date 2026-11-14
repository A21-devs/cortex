/**
 * Pages, readers and dialogs (owners E12, E6, E9; CORTEX-UX §5.13–§5.30): every sheet route and reader renders,
 * the inert renderer never interprets HTML or code (SAFE-01), and the pure helpers behind each page match the
 * UX rules (relative times, day sections, map recency, trends, rhythm colours, tables, caps, checks keys, runs
 * filters, new-entry paths, first-run choice, typed paths).
 */
import { render } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { READER_ROUTES, SHEET_PAGE_ROUTES } from "../src/shared/views";
import { COUNT_RAMP } from "../src/shared/palette";
import { writtenEntryPath } from "../src/plugin/newEntry";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { isAbsoluteTypedPath } from "../src/ui/modals/pickPath";
import { applyFirstRunChoice } from "../src/ui/modals/FirstRunModal";
import { isoFromFields } from "../src/ui/modals/CorrectionModals";
import { SHEET_PAGES } from "../src/ui/pages";
import { byDay } from "../src/ui/pages/ChangeHistory";
import { keyToAnswer } from "../src/ui/pages/Checks";
import { GUIDE_CARDS } from "../src/ui/pages/Guide";
import { canSave } from "../src/ui/pages/NewEntry";
import { emptyPlanViews } from "../src/shared/planLimits";
import { relTime } from "../src/ui/pages/PageFrame";
import { daySection, mapRecency } from "../src/ui/pages/Read";
import { rhythmColour } from "../src/ui/pages/RhythmGrid";
import { matchesRun } from "../src/ui/pages/RunsLedger";
import { statusKey } from "../src/ui/pages/Sources";
import { tickLength, tauToX } from "../src/ui/pages/SpineFigure";
import { shareTrend } from "../src/ui/pages/Time";
import { tableToCsv, tableToMarkdown } from "../src/ui/pages/TimeData";
import { ReaderRouter } from "../src/ui/reader/Reader";
import { SafeMarkdown } from "../src/ui/reader/SafeMarkdown";
import { parseSafeMarkdown } from "../src/ui/reader/inertMarkdown";
import { scrubIndex } from "../src/ui/reader/FrondScrubber";
import { evidenceMeter } from "../src/ui/reader/MapReader";
import { migrateSettings } from "../src/shared/settings";
import { fakeServices } from "./helpers/fakeServices";
import { Setting } from "obsidian";
import { COPY, t } from "../src/ui/copy";
import { CommandLine, matchPages, pageActions } from "../src/ui/command/CommandLine";
import { groupFindRows, RESULTS_PER_GROUP, splitMatch, type FindRow } from "../src/ui/command/FindResults";
import { DRAFT_TOKEN_ID, Tokens, visibleTokens } from "../src/ui/command/Tokens";
import { emptyText, folderName, workerSort } from "../src/ui/pages/Read";
import { sortDataRows } from "../src/ui/pages/TimeData";
import { brushFromPeriod, periodFromBrush, xToTau } from "../src/ui/pages/SpineFigure";
import { weekdayLabels } from "../src/ui/pages/RhythmGrid";
import { leftAloneLine, runsToCsv, statusLine } from "../src/ui/pages/Agents";
import { answerText, isUnsure } from "../src/ui/pages/Checks";
import { attentionText, selectorFor } from "../src/ui/pages/Sources";
import { dayBound } from "../src/ui/pages/RunsLedger";
import { sortAccess } from "../src/ui/pages/AccessLog";
import { keyRows } from "../src/ui/pages/Guide";
import { pageFor, partAt } from "../src/ui/reader/Thread";
import { applyPose, CortexSettingTab, issueText, shownPose, validPattern, visibleSections } from "../src/plugin/settingsTab";
import { makeFmt } from "../src/ui/pages/PageFrame";
import type { ActivityState } from "../src/state/types";

const h = fakeServices();
const wrap = (node: preact.ComponentChild) =>
  render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );

describe("sheet routes and readers render", () => {
  it("every page route renders with its tabs param", () => {
    for (const route of SHEET_PAGE_ROUTES) {
      const Page = SHEET_PAGES[route];
      expect(() => wrap(<Page params={{}} />), route).not.toThrow();
    }
    expect(wrap(<SHEET_PAGES.time params={{ tab: "data" }} />)).toContain("Pick what to count");
    expect(wrap(<SHEET_PAGES.agents params={{}} />)).toContain("Model runs, their cost in tokens, and what they changed.");
    expect(wrap(<SHEET_PAGES.sources params={{}} />)).toContain("Everything Cortex reads");
    expect(wrap(<SHEET_PAGES.sources params={{ tab: "privacy" }} />)).toContain("What stays off limits");
    expect(wrap(<SHEET_PAGES.agents params={{ tab: "access" }} />)).toContain("Every time a model read part of your record");
    const NewEntryPage = SHEET_PAGES["new-entry"];
    expect(wrap(<NewEntryPage params={{}} />)).toContain("Write in your own words.");
  });
  it("every reader route renders", () => {
    for (const route of READER_ROUTES) expect(() => wrap(<ReaderRouter entry={{ kind: "reader", route, id: "e_aaaaaaaaaaaaaaaa" }} />), route).not.toThrow();
    expect(GUIDE_CARDS.length).toBe(5);
  });
});

describe("reader/SafeMarkdown (SAFE-01)", () => {
  it("renders structure as inert text and never interprets HTML, embeds or code", () => {
    const html = render(<SafeMarkdown text={"# Title\nSome **bold** and a [link](https://x.test).\n\n- one\n- two\n\n```dataviewjs\nalert(1)\n```\n<script>alert(2)</script>\n![img](https://evil/x.png)"} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).toContain("<pre>alert(1)</pre>");
    expect(html).toContain("<strong>bold</strong>");
    expect(parseSafeMarkdown("1. a\n2. b")[0]).toMatchObject({ kind: "list", ordered: true });
  });
});

describe("page helpers", () => {
  const now = Date.UTC(2026, 10, 9, 15);
  it("Read: relative times, day sections and map recency", () => {
    expect(relTime(now - 2 * 3_600_000, now, () => "date")).toBe("2 h");
    expect(relTime(now - 6 * 86_400_000, now, () => "date")).toBe("6 d");
    expect(relTime(now - 21 * 86_400_000, now, () => "date")).toBe("3 w");
    expect(relTime(now - 200 * 86_400_000, now, () => "date")).toBe("date");
    expect(daySection(now, now).key).toBe("today");
    expect(daySection(now - 86_400_000, now).key).toBe("yesterday");
    expect(daySection(now - 90 * 86_400_000, now).key).toBe("month");
    const day = 86_400_000;
    expect(mapRecency(0, 10 * day)).toBe("active");
    expect(mapRecency(0, 60 * day)).toBe("cooling");
    expect(mapRecency(0, 200 * day)).toBe("dormant");
  });
  it("Time: trends, the spine scale, rhythm colours and data tables", () => {
    expect(shareTrend([0.2, 0.2, 0.3, 0.4, 0.5, 0.5])).toBe("rising");
    expect(shareTrend([0.3, 0.31, 0.3])).toBe("steady");
    expect(tauToX(0)).toBe(8);
    expect(tauToX(1)).toBe(352);
    expect(tickLength(0)).toBe(0);
    expect(rhythmColour(0, 10)).toBe(COUNT_RAMP.emptyDark);
    expect(rhythmColour(10, 10)).toBe(COUNT_RAMP.dark[COUNT_RAMP.dark.length - 1]);
    const tb = { rows: ["Roblox", "Vault, notes"], columns: ["Oct", "Nov"], cells: [1, 2, 3, 4] };
    expect(tableToCsv(tb, "Area")).toBe('Area,Oct,Nov\nRoblox,1,2\n"Vault, notes",3,4');
    expect(tableToMarkdown(tb, "Area").split("\n")[2]).toBe("| Roblox | 1 | 2 |");
  });
  it("Agents, Checks, Sources, Change history and Runs", () => {
    expect(keyToAnswer("1")).toBe("confirm");
    expect(keyToAnswer("3")).toBe("open-reject");
    expect(keyToAnswer("z")).toBe("undo");
    expect(statusKey("watching")).toBe("sources.statusWatching");
    expect(byDay([{ at: "2026-11-08T10:00:00Z" }, { at: "2026-11-09T09:00:00Z" }, { at: "2026-11-09T10:00:00Z" }]).map((d) => [d.day, d.items.length])).toEqual([
      ["2026-11-09", 2],
      ["2026-11-08", 1],
    ]);
    expect(matchesRun({ job: "label", model: "haiku", status: "finished", where: "remote", startedAt: "2026-11-09T10:00:00Z" } as never, { job: "label", from: "2026-11-09" })).toBe(true);
    expect(matchesRun({ job: "gist", model: "sonnet", status: "failed", where: "remote", startedAt: "2026-11-09T10:00:00Z" } as never, { job: "label" })).toBe(false);
  });
  it("New entry, the first-run choice, correction dialogs and typed paths", () => {
    expect(canSave("  ")).toBe(false);
    expect(writtenEntryPath(new Date(2026, 10, 9, 14, 5), "Ideas for the shop!")).toBe(".raw/written/2026/11/20261109-1405-ideas-for-the-shop.md");
    const s = migrateSettings(undefined);
    applyFirstRunChoice("import-only")(s);
    expect([s.general.firstRunDone, s.general.firstRunChoice, s.agents.enabled]).toEqual([true, "import-only", false]);
    expect(isoFromFields("2026-10-02", "")).toMatch(/^2026-10-0[12]T/);
    expect(isoFromFields("2026-13-02")).toBeNull();
    expect(isAbsoluteTypedPath("C:\\Users\\you\\Downloads\\export.zip")).toBe(true);
    expect(isAbsoluteTypedPath("..\\x")).toBe(false);
  });
  it("Readers: frond scrubber steps and evidence meters", () => {
    expect(scrubIndex(0, 360, 549)).toBe(0);
    expect(scrubIndex(360, 360, 549)).toBe(548);
    expect(scrubIndex(359, 360, 549)).toBe(547);
    expect(evidenceMeter(1, 3)).toEqual({ you: 1 / 3, assistant: 1 });
  });
});

describe("copy catalogue (RFC E1 §3)", () => {
  it("has the status bar, notice and Spin strings other modules look up", () => {
    expect(COPY.statusBar.settings).toBe("Cortex · check settings");
    expect(COPY.statusBar.importingNoTotal).toBe("Cortex · importing");
    expect(COPY.statusBar.indexingNoTotal).toBe("Cortex · indexing");
    expect(COPY.statusBar.limit).toBe("Cortex · usage limit reached");
    expect(COPY.statusBar.unsafe).toBe("Cortex · agents off");
    expect(COPY.statusBar.off).toBe("Cortex · agents off");
    expect(t("notices.failed")).toBe("Cortex couldn't finish that. Nothing was changed.");
    expect(t("notices.busy")).toContain("busy");
    expect(t("notices.notFound")).toContain("couldn't find");
    expect(t("tools.spin")).toBe("Spin");
  });
});

describe("Find: command line, tokens and results", () => {
  const row = (key: string, group: FindRow["group"]): FindRow => ({ key, group, icon: "document", title: key, meta: "", action: { kind: "item", ordinal: 1 } });
  it("shows five rows per group with the true total, and everything once expanded", () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => row(`e${i}`, "entries")), row("n1", "notes")];
    const groups = groupFindRows(rows, new Set());
    expect(groups.map((g) => [g.id, g.rows.length, g.total])).toEqual([["entries", RESULTS_PER_GROUP, 9], ["notes", 1, 1]]);
    expect(groupFindRows(rows, new Set(["entries"]))[0]?.rows.length).toBe(9);
    expect(groupFindRows([], new Set())).toEqual([]);
  });
  it("underlines the first case-insensitive match of the query", () => {
    expect(splitMatch("Roblox shop plan", "SHOP")).toEqual({ before: "Roblox ", match: "shop", after: " plan" });
    expect(splitMatch("Nothing here", "xyz")).toEqual({ before: "Nothing here", match: "", after: "" });
  });
  it("matches pages and actions by name", () => {
    expect(matchPages("sour").map((p) => p.id)).toEqual(["sources"]);
    expect(matchPages("")).toEqual([]);
    expect(pageActions().some((p) => p.id === "checks")).toBe(true);
  });
  it("hides the draft text token from the pills", () => {
    const toks = [{ id: DRAFT_TOKEN_ID, kind: "text" as const, label: "draft-label" }, { id: "a", kind: "group" as const, label: "Area: Roblox" }];
    expect(visibleTokens(toks).map((x) => x.id)).toEqual(["a"]);
    h.leaf.store.update("ui", (u) => ({ ...u, tokens: toks }));
    const html = wrap(<Tokens />);
    expect(html).toContain("Area: Roblox");
    expect(html).not.toContain("draft-label");
    h.leaf.store.update("ui", (u) => ({ ...u, tokens: [] }));
  });
  it("renders a role=search bar with the Find placeholder in a single bar element", () => {
    const html = wrap(<CommandLine />);
    expect(html).toContain('role="search"');
    expect(html).toContain('class="cx-command-bar"');
    expect(html).toContain("Find anything in your record");
    expect(html).toContain('role="combobox"');
  });
});

describe("page logic added by the full pages", () => {
  it("Read: worker sort names, folder names and empty states", () => {
    expect(workerSort("messages")).toBe("size");
    expect(workerSort("title")).toBe("title");
    expect(folderName("Roblox/Shop/Ideas")).toBe("Ideas");
    expect(emptyText({ query: "shop", pinnedOnly: false, today: false, folder: null })).toContain("“shop”");
    expect(emptyText({ query: "", pinnedOnly: true, today: false, folder: null })).toBe(t("read.pinnedEmpty"));
    expect(emptyText({ query: "", pinnedOnly: false, today: true, folder: null })).toBe(t("read.todayEmpty"));
  });
  it("Time: brush and period, week labels and sorted data rows", () => {
    const fronds = [{ tau: 0.1, ms: 100 }, { tau: 0.5, ms: 500 }, { tau: 0.9, ms: 900 }];
    expect(periodFromBrush(fronds, 0.45, 0.95)).toEqual([500, 900]);
    expect(periodFromBrush(fronds, 0.5, 0.5)).toBeNull();
    expect(brushFromPeriod(fronds, [400, 1000])).toEqual([0.5, 0.9]);
    expect(brushFromPeriod(fronds, null)).toBeNull();
    expect(xToTau(8)).toBe(0);
    expect(xToTau(352)).toBe(1);
    expect(weekdayLabels(0)[0]).toBe("Sun");
    expect(weekdayLabels(1)[0]).toBe("Mon");
    const rows = [{ key: "a", label: "A", total: 1, share: 0.1, cells: [5] }, { key: "b", label: "B", total: 9, share: 0.9, cells: [2] }];
    expect(sortDataRows(rows, "total", true).map((r) => r.key)).toEqual(["b", "a"]);
    expect(sortDataRows(rows, 0, false).map((r) => r.key)).toEqual(["b", "a"]);
    expect(sortDataRows(rows, "label", false).map((r) => r.key)).toEqual(["a", "b"]);
  });
  it("Agents: status sentences, ledger export, access sort", () => {
    const fmt = makeFmt("d MMM yyyy", 1, Date.UTC(2026, 10, 9));
    const base: ActivityState = { jobs: [], tokensToday: 0, usdToday: 0, plan: emptyPlanViews(), capped: false, paused: false, runner: "child", engine: "ok", settingsCorrupt: false };
    expect(statusLine("paused", base, { claudePath: "p", fmt }).text).toBe(t("agents.paused"));
    expect(statusLine("missing", base, { claudePath: "C:/x/claude.exe", fmt }).text).toContain("C:/x/claude.exe");
    expect(statusLine("idle", base, { claudePath: "p", fmt }).text).toBe(t("agents.upToDateNever"));
    // Never "up to date" while the runner holds work: it says when the agents start.
    expect(statusLine("idle", base, { claudePath: "p", fmt, lastRun: Date.UTC(2026, 10, 8), waiting: 1234 })).toEqual({ text: "1,234 items waiting · starting within a minute", tone: "accent" });
    expect(statusLine("idle", base, { claudePath: "p", fmt, waiting: 8, idleOnly: true }).text).toBe("8 items waiting · starting after 60 seconds without typing");
    expect(statusLine("idle", base, { claudePath: "p", fmt, waiting: 0 }).text).toBe(t("agents.upToDateNever"));
    expect(leftAloneLine({ sessions: 302, notes: 1367 })).toBe("Left as they are: 302 sessions with no message from you · 1,367 imported files. The agents label your conversations and your vault's notes.");
    expect(leftAloneLine({ sessions: 0, notes: 5 })).toBe("Left as they are: 5 imported files. The agents label your conversations and your vault's notes.");
    expect(statusLine("off", base, { claudePath: "p", fmt }).tone).toBe("muted");
    const run = { startedAt: "2026-11-09T10:00:00Z", job: "label", model: "haiku", items: 3, labels: 2, declined: 0, noAnswer: 0, tokensIn: 10, tokensOut: 5, status: "finished" };
    expect(runsToCsv([run as never]).split("\n")[1]).toBe("2026-11-09T10:00:00Z,label,haiku,3,2,0,0,10,5,done");
    const log = [
      { model: "a", route: "r", itemsRead: 1, first: "2026-01-01", last: "2026-02-01" },
      { model: "b", route: "r", itemsRead: 5, first: "2026-01-01", last: "2026-01-02" },
    ];
    expect(sortAccess(log, "itemsRead", true).map((r) => r.model)).toEqual(["b", "a"]);
    expect(sortAccess(log, "last", false).map((r) => r.model)).toEqual(["b", "a"]);
  });
  it("Checks: unsure threshold and answer words", () => {
    expect(isUnsure({ confidence: 0.59 })).toBe(true);
    expect(isUnsure({ confidence: 0.6 })).toBe(false);
    expect(isUnsure({})).toBe(false);
    expect(answerText({ kind: "confirm" })).toBe("confirmed");
    expect(answerText({ kind: "mention", mine: false })).toBe("marked as not you");
    expect(answerText({ kind: "conflict", keep: "theirs" })).toBe("used the agents' version");
  });
  it("Sources: importer selectors, attention sentences from the catalogue and run filter dates", () => {
    expect(selectorFor({ id: "claude-code", kind: "claude-code" })).toEqual({ kind: "claude-code" });
    expect(selectorFor({ id: "chatgpt", kind: "chatgpt" })).toBeNull();
    expect(attentionText({ code: "not-local", count: 4 })).toBe("4 files are in OneDrive but not on this computer yet.");
    expect(attentionText({ code: "onedrive-conflict-copy", count: 1, detail: "runs.jsonl" })).toContain("runs.jsonl");
    expect(attentionText({ code: "path-unreadable", count: 1 })).toBe(t("sources.pathUnreadable"));
    expect(dayBound("2026-11-09", false)).toMatch(/^2026-11-0[89]T/);
    expect(dayBound("nope", true)).toBeUndefined();
  });
  it("Guide: the keyboard table pairs keys with what they do", () => {
    const rows = keyRows();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.find((r) => r.id === "focusFind")?.keys).toBe("Ctrl K or /");
    expect(rows.every((r) => r.action.length > 0)).toBe(true);
  });
  it("Thread: pages of 200 and the part a message falls in", () => {
    expect(pageFor(0, 549)).toEqual({ from: 0, to: 200 });
    expect(pageFor(450, 549)).toEqual({ from: 400, to: 549 });
    expect(pageFor(9999, 549).from).toBe(400);
    const parts = [
      { n: 1, msgFrom: 0, msgTo: 99, notes: [] },
      { n: 2, msgFrom: 100, msgTo: 548, notes: [] },
    ];
    expect(partAt(parts, 150)?.n).toBe(2);
    expect(partAt(parts, 900)).toBeNull();
  });
});

describe("settings tab", () => {
  it("the Pose row records that you chose it, and an unchosen pose reads as Standing", () => {
    const s = migrateSettings({ general: { pose: "lying" } });
    expect(s.general.poseChosen).toBe(false);
    expect(shownPose(s)).toBe("standing");
    applyPose(s, "lying");
    expect([s.general.pose, s.general.poseChosen, shownPose(s)]).toEqual(["lying", true, "lying"]);
  });
  it("validates patterns and settings problems with catalogue text", () => {
    expect(validPattern("ACME-\\d+")).toBe(true);
    expect(validPattern("(")).toBe(false);
    expect(issueText({ path: "agents.paused", problem: "wrong-type", action: "used-safe-value" })).toBe("agents.paused: a value of the wrong kind");
  });
  it("builds every visible section without touching services", () => {
    const created = (Setting as unknown as { created: { name: string }[] }).created;
    const hh = fakeServices();
    const tab = new CortexSettingTab(hh.services.app as never, { plugin: { manifest: { version: "0.1.0" } } as never, settings: () => hh.services.settings, services: () => Promise.reject(new Error("not needed")) });
    for (const section of visibleSections()) {
      created.length = 0;
      tab.section = section;
      expect(() => tab.display()).not.toThrow();
      expect(created.length, section).toBeGreaterThan(3);
    }
    created.length = 0;
    tab.section = "general";
    tab.display();
    expect(created.map((x) => x.name)).toContain("Pose");
  });
});

describe("Checks: Confirm all", () => {
  it("covers labels, summaries, filing and directions, never a mention or a conflict, and skips the ones you skipped", async () => {
    const { bulkConfirmable, CONFIRM_ALL_ASK_ABOVE } = await import("../src/ui/pages/Checks");
    const cards = [
      { id: "a", kind: "label" },
      { id: "b", kind: "mention" },
      { id: "c", kind: "note" },
      { id: "d", kind: "conflict" },
      { id: "e", kind: "filing" },
      { id: "f", kind: "direction" },
    ] as const;
    expect(bulkConfirmable(cards).map((c) => c.id)).toEqual(["a", "c", "e", "f"]);
    expect(bulkConfirmable(cards, new Set(["c"])).map((c) => c.id)).toEqual(["a", "e", "f"]);
    expect(bulkConfirmable([])).toEqual([]);
    expect(CONFIRM_ALL_ASK_ABOVE).toBe(25);
  });

  it("writes one batch and hands back an Undo that reverses exactly those corrections", async () => {
    const { confirmAllChecks } = await import("../src/ui/pages/Checks");
    const confirmChecks = vi.fn(async (ids: readonly string[]) => ({ confirmed: ids.slice(0, 2) as string[], left: ids.slice(2) as string[], ids: ["k_1", "k_2", "k_3"] as never[] }));
    const undoMany = vi.fn(async () => []);
    const r = await confirmAllChecks({ confirmChecks, undoMany } as never, ["a", "b", "c"]);
    expect(confirmChecks).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ confirmed: 2, left: 1 });
    await r.undo?.();
    expect(undoMany).toHaveBeenCalledWith(["k_1", "k_2", "k_3"], "checks");
    const none = await confirmAllChecks({ confirmChecks: async () => ({ confirmed: [], left: ["a"], ids: [] }), undoMany } as never, ["a"]);
    expect(none.undo).toBeUndefined();
  });
});
