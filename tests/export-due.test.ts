/**
 * Export reminders and the Add to your record sheet: due computation (shared/exportDue.ts), the importer
 * aggregator (importers/extra), the optional daily reminder, the settings default, and the sheet itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_EXPORT_SOURCES,
  DEFAULT_ARCHIVE_CADENCE_DAYS,
  cadenceFor,
  dayKey,
  dueThisMonth,
  exportSourceOf,
  exportStatus,
  exportSources,
  exportStatuses,
  isSafeExportUrl,
  requestExport,
  shouldRemind,
} from "../src/shared/exportDue";
import { EXTRA_GROUPS, extraImporters, type ExtraImporter, type ExtraImporterGroup } from "../src/importers/extra";
import { createImporters } from "../src/importers/registry";
import { DEFAULT_SETTINGS, migrateSettings, type CortexSettings } from "../src/shared/settings";
import { reminderFor, runExportReminder, REMINDER_KEY } from "../src/plugin/exportReminder";
import { arrivalText } from "../src/ui/exportText";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime(); // 11 Nov 2026, local noon
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const claude = exportSourceOf("claude-ai")!;

describe("exportStatus", () => {
  it("counts whole days since the last export and the days left of the 30-day cadence", () => {
    const s = exportStatus(claude, ago(8), NOW);
    expect([s.daysAgo, s.cadenceDays, s.dueInDays, s.due]).toEqual([8, DEFAULT_ARCHIVE_CADENCE_DAYS, 22, false]);
    expect(arrivalText(s)).toBe("Arrived 8 days ago · due in 22 days");
  });
  it("is due exactly when the cadence has run out, and overdue after", () => {
    expect(exportStatus(claude, ago(29), NOW).due).toBe(false);
    const on = exportStatus(claude, ago(30), NOW);
    expect([on.due, on.dueInDays]).toEqual([true, 0]);
    const over = exportStatus(claude, ago(35), NOW);
    expect([over.due, over.dueInDays]).toEqual([true, -5]);
    expect(arrivalText(over)).toBe("Arrived 35 days ago · 5 days overdue");
  });
  it("never nags for a source that has not arrived, and reads a bad or future date as 'not yet' or today", () => {
    for (const bad of [undefined, "", "not a date"]) {
      const s = exportStatus(claude, bad, NOW);
      expect([s.daysAgo, s.dueInDays, s.due, s.dueThisMonth]).toEqual([null, null, false, false]);
      expect(arrivalText(s)).toBe("Nothing has arrived yet");
    }
    const future = exportStatus(claude, new Date(NOW + 3 * DAY).toISOString(), NOW);
    expect(future.daysAgo).toBe(0);
    expect(arrivalText(exportStatus(claude, ago(1), NOW))).toBe("Arrived yesterday · due in 29 days");
    expect(arrivalText(exportStatus(claude, ago(0), NOW))).toBe("Arrived today · due in 30 days");
    expect(arrivalText(exportStatus(claude, ago(29), NOW))).toBe("Arrived 29 days ago · due tomorrow");
    expect(arrivalText(exportStatus(claude, ago(30), NOW))).toBe("Arrived 30 days ago · due today");
  });
  it("flags 'due this month' when the next export falls by the end of the calendar month", () => {
    // 11 Nov: a 22-day-old export is due on 19 Nov (this month); a 5-day-old one on 6 Dec (next month).
    expect(exportStatus(claude, ago(22), NOW).dueThisMonth).toBe(true);
    expect(exportStatus(claude, ago(5), NOW).dueThisMonth).toBe(false);
    expect(exportStatus(claude, ago(60), NOW).dueThisMonth).toBe(true); // overdue counts
  });
  it("honours a person's cadence only when it is a whole number in range", () => {
    expect(cadenceFor(claude, { "claude-ai": 14 })).toBe(14);
    for (const bad of [0, -3, 400, 7.5, "7", null]) expect(cadenceFor(claude, { "claude-ai": bad })).toBe(30);
    expect(cadenceFor({ id: "x", cadenceDays: 90 })).toBe(90);
    const s = exportStatus(claude, ago(10), NOW, { "claude-ai": 7 });
    expect([s.due, s.dueInDays]).toEqual([true, -3]);
  });
});

describe("statuses from the ledger", () => {
  const rows = [{ id: "claude-ai", lastImport: ago(40) }, { id: "chatgpt", lastImport: ago(20) }, { id: "vault" }];
  it("covers every archive source in catalogue order and ignores the others", () => {
    const st = exportStatuses(rows, NOW);
    expect(st.map((s) => s.id)).toEqual(exportSources().map((s) => s.id));
    expect(st.map((s) => s.id).slice(0, BUILTIN_EXPORT_SOURCES.length)).toEqual(BUILTIN_EXPORT_SOURCES.map((s) => s.id));
    expect(st.find((s) => s.id === "gemini")?.daysAgo).toBeNull();
  });
  it("lists the due-this-month group most overdue first, and the daily reminder only once a day", () => {
    const st = exportStatuses(rows, NOW);
    expect(dueThisMonth(st).map((s) => s.id)).toEqual(["claude-ai", "chatgpt"]);
    expect(shouldRemind(st, "2026-11-11", null).map((s) => s.id)).toEqual(["claude-ai"]);
    expect(shouldRemind(st, "2026-11-11", "2026-11-11")).toEqual([]);
    expect(shouldRemind(st, "2026-11-11", "2026-11-10").length).toBe(1);
    expect(dayKey(NOW)).toBe("2026-11-11");
  });
});

describe("Request an export", () => {
  it("opens only the provider's https page, and only through the opener it is given", () => {
    const open = vi.fn();
    for (const s of BUILTIN_EXPORT_SOURCES) {
      expect(isSafeExportUrl(s.exportUrl)).toBe(true);
      expect(requestExport(s.exportUrl, open)).toBe(true);
    }
    expect(open).toHaveBeenCalledTimes(BUILTIN_EXPORT_SOURCES.length);
    for (const bad of ["http://claude.ai/", "javascript:alert(1)", "file:///C:/x", "https://user:pw@claude.ai/", "claude.ai", "https://localhost/"]) {
      expect(requestExport(bad, open)).toBe(false);
    }
    expect(open).toHaveBeenCalledTimes(BUILTIN_EXPORT_SOURCES.length);
  });
});

describe("importer aggregator", () => {
  const fake = (kind: string): ExtraImporter => ({ kind, source: "files", label: kind, discover: async () => [], run: async () => ({}) }) as unknown as ExtraImporter;
  it("ships its groups, and the registry holds its core importers plus theirs", () => {
    expect(EXTRA_GROUPS.map((g) => g.name)).toEqual(["chatExports", "notesDocs", "agentCli", "capture"]);
    const extra = Object.keys(extraImporters());
    const all = Object.keys(createImporters());
    expect(all).toEqual(expect.arrayContaining(["chatgpt", "claude-ai", "claude-code", "folder", "gemini", "raw", "vault-notes", "written"]));
    expect(all.sort()).toEqual([...new Set([...all, ...extra])].sort());
  });
  it("merges groups, and refuses a duplicate kind or a mislabelled importer", () => {
    const a: ExtraImporterGroup = { name: "a", importers: { slack: fake("slack") } };
    const b: ExtraImporterGroup = { name: "b", importers: { discord: fake("discord") } };
    expect(Object.keys(extraImporters([a, b])).sort()).toEqual(["discord", "slack"]);
    expect(() => extraImporters([a, { name: "c", importers: { slack: fake("slack") } }])).toThrow(/already registered/);
    expect(() => extraImporters([{ name: "d", importers: { slack: fake("other") } }])).toThrow(/kind "other"/);
  });
});

describe("export reminder setting and notice", () => {
  const settings = (over: (s: CortexSettings) => void): CortexSettings => {
    const s = structuredClone(DEFAULT_SETTINGS);
    over(s);
    return s;
  };
  it("is off by default, survives migration, and keeps a person's cadence overrides", () => {
    expect(DEFAULT_SETTINGS.sources.exportReminders).toEqual({ notify: false, cadenceDays: {} });
    expect(migrateSettings({}).sources.exportReminders.notify).toBe(false);
    const m = migrateSettings({ version: 5, sources: { exportReminders: { notify: true, cadenceDays: { chatgpt: 14 } } } });
    expect(m.sources.exportReminders).toEqual({ notify: true, cadenceDays: { chatgpt: 14 } });
    expect(migrateSettings({ version: 5, sources: { exportReminders: { notify: "yes" } } }).sources.exportReminders.notify).toBe(false);
  });
  it("shows nothing while off, one notice naming what is due when on, and nothing more that day", () => {
    const rows = [{ id: "claude-ai", lastImport: ago(31) }, { id: "chatgpt", lastImport: ago(2) }];
    expect(reminderFor({ settings: DEFAULT_SETTINGS, rows, now: NOW, lastShown: null })).toBeNull();
    const on = settings((s) => void (s.sources.exportReminders.notify = true));
    const r = reminderFor({ settings: on, rows, now: NOW, lastShown: null });
    expect(r).toEqual({ text: "An export is due from Claude.ai. Open Sources to request it.", day: "2026-11-11" });
    expect(reminderFor({ settings: on, rows, now: NOW, lastShown: "2026-11-11" })).toBeNull();
    expect(reminderFor({ settings: on, rows: [], now: NOW, lastShown: null })).toBeNull();
  });
  it("runExportReminder reads the list, marks the day on this device and never opens anything", async () => {
    const store = new Map<string, string>();
    const app = { loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: string | null) => void (v === null ? store.delete(k) : store.set(k, v)) };
    const on = settings((s) => void (s.sources.exportReminders.notify = true));
    const list = vi.fn(async () => [{ id: "chatgpt", lastImport: ago(45) }]);
    const svc = { settings: { value: on }, sandbox: { value: false }, sources: { list } } as never;
    expect(await runExportReminder(app as never, svc, NOW)).toBe(true);
    expect(store.get(REMINDER_KEY)).toBe("2026-11-11");
    expect(await runExportReminder(app as never, svc, NOW)).toBe(false);
    const off = { settings: { value: DEFAULT_SETTINGS }, sandbox: { value: false }, sources: { list } } as never;
    list.mockClear();
    expect(await runExportReminder(app as never, off, NOW)).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("Add to your record sheet", () => {
  // The rows are dated from NOW and the sheet reads the clock: it reads NOW too, so the lines are the same on any day.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  interface Node {
    tag?: string;
    text?: string;
    classes: Set<string>;
    listeners: Map<string, ((e?: unknown) => void)[]>;
    children?: Node[];
    allText(): string[];
  }
  const build = async (rows: unknown[]) => {
    const { AddSourcesModal } = await import("../src/ui/modals/AddSourcesModal");
    const settings = structuredClone(DEFAULT_SETTINGS);
    const services = {
      settings: { value: settings, update: async (fn: (s: CortexSettings) => void) => fn(settings) },
      sandbox: { value: false },
      sources: {
        list: async () => rows,
        estimate: async () => ({ sources: [], conversations: 0, notes: 0, tokens: 0 }),
        needsAttention: async () => [],
        inspect: async () => ({ kind: "unknown", conversations: 0, projects: 0, attachments: 0, alreadyImported: 0 }),
        importNow: async () => undefined,
        pauseWatching: async () => undefined,
      },
    };
    const modal = new AddSourcesModal({} as never, services as never);
    (modal as unknown as { open(): void }).open();
    await new Promise((r) => setTimeout(r, 20));
    return { modal, content: (modal as unknown as { contentEl: Node }).contentEl };
  };
  const rows = [
    { id: "claude-ai", kind: "claude-ai", status: "imported", items: 4, yourShare: 0.3, storedIn: ".raw/chats/claude-ai/", watching: false, lastImport: ago(8) },
    { id: "chatgpt", kind: "chatgpt", status: "imported", items: 4, yourShare: 0.3, storedIn: ".raw/chats/chatgpt/", watching: false, lastImport: ago(40) },
  ];
  it("has the drop zone, Choose files, Open folder, a how-to per source and an arrival line per export", async () => {
    const { modal, content } = await build(rows);
    const text = content.allText().join("\n");
    expect((modal as unknown as { titleEl: { text: string } }).titleEl.text).toBe("Add to your record");
    for (const s of ["Drop anything here", "Choose files", "Open folder", "Settings › Privacy › Export data.", "Settings › Data controls › Export data.", "Google Takeout: tick Gemini Apps", "Read where they are. Nothing to export."]) expect(text).toContain(s);
    expect(text).toContain("Arrived 8 days ago · due in 22 days");
    expect(text).toContain("Arrived 40 days ago · 10 days overdue");
    expect(text).toContain("Nothing has arrived yet"); // Gemini
    expect(text).toContain("Due this month");
    expect(text.match(/Request an export/g)?.length).toBeGreaterThanOrEqual(3);
    (modal as unknown as { close(): void }).close();
  });
  it("Request an export opens the provider's page in the browser and sends nothing", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const { modal, content } = await build(rows);
    const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)];
    const buttons = all(content).filter((n) => n.tag === "button" && n.text === "Request an export");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) b.listeners.get("click")?.[0]?.();
    expect(open).toHaveBeenCalled();
    for (const [url] of open.mock.calls as [string][]) expect(url.startsWith("https://")).toBe(true);
    (modal as unknown as { close(): void }).close();
  });
});
