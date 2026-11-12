/** The tray menu (desktop/trayMenu.ts): its shape, its wording, the status lines and the untrusted message. */
import { describe, expect, it } from "vitest";
import { commandAvailable, isCommandId } from "../src/plugin/commands";
import { isSafeExportUrl } from "../src/shared/exportDue";
import { COPY, t } from "../src/ui/copy";
import { agentsText, agoText, buildTrayStatus, emptyTrayStatus, parseHostState, todayText, trayCommandIds, trayMenu, trayTooltip, updateText, usdText, type TrayNode, type TrayStatus, type TrayStatusInput } from "../src/desktop/trayMenu";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;

function input(patch: Partial<TrayStatusInput> = {}): TrayStatusInput {
  return {
    locked: false,
    liveOn: true,
    rows: [
      { id: "claude-code", lastImport: new Date(NOW - 16 * MIN).toISOString() },
      { id: "claude-ai", lastImport: new Date(NOW - 8 * DAY).toISOString() },
      { id: "chatgpt", lastImport: new Date(NOW - 40 * DAY).toISOString() },
    ],
    bySource: { "claude-code": { done: 40, waiting: 10, checked: 5 }, "claude-ai": { done: 20, waiting: 5, checked: 0 } },
    waiting: 15,
    tokensToday: 12_400,
    usdToday: 0.19,
    showTodayCost: true,
    cadenceOverrides: {},
    now: NOW,
    space: "Work",
    ...patch,
  };
}

const flat = (nodes: readonly TrayNode[]): TrayNode[] => nodes.flatMap((n) => (n.kind === "submenu" ? [n, ...flat(n.items)] : [n]));
const labels = (nodes: readonly TrayNode[]): string[] => flat(nodes).flatMap((n) => (n.kind === "separator" ? [] : [n.label]));

describe("ago and price wording", () => {
  it("counts minutes, hours and days", () => {
    expect(agoText(NOW, NOW)).toBe("just now");
    expect(agoText(NOW - 30_000, NOW)).toBe("just now");
    expect(agoText(NOW + 5 * MIN, NOW)).toBe("just now");
    expect(agoText(NOW - MIN, NOW)).toBe("1 minute ago");
    expect(agoText(NOW - 16 * MIN, NOW)).toBe("16 minutes ago");
    expect(agoText(NOW - 60 * MIN, NOW)).toBe("1 hour ago");
    expect(agoText(NOW - 5 * 60 * MIN, NOW)).toBe("5 hours ago");
    expect(agoText(NOW - DAY, NOW)).toBe("yesterday");
    expect(agoText(NOW - 4 * DAY, NOW)).toBe("4 days ago");
  });

  it("formats the price and the today line", () => {
    expect(usdText(42.264)).toBe("$42.26");
    expect(usdText(0)).toBe("$0.00");
    expect(usdText(Number.NaN)).toBe("$0.00");
    expect(usdText(1234.5)).toBe("$1,235");
    expect(todayText({ tokens: 12_400, usd: 0.19 })).toBe("Today: 12,400 tokens, $0.00 billed, $0.19 on your plans at API prices");
    expect(todayText({ tokens: 900, usd: 0.001 })).toBe("Today: 900 tokens");
    expect(todayText({ tokens: 0, usd: 0 })).toBe("Today: no tokens used yet");
  });
});

describe("buildTrayStatus", () => {
  it("counts the record, the queue and the newest import", () => {
    const s = buildTrayStatus(input());
    expect(s.record).toEqual({ labelled: 65, total: 80 });
    expect(s.waiting).toBe(15);
    expect(s.lastAddedAt).toBe(NOW - 16 * MIN);
    expect(s.liveOn).toBe(true);
    expect(s.today).toEqual({ tokens: 12_400, usd: 0.19 });
    expect(s.space).toBe("Work");
  });

  it("hides the cost when the setting says so, and never goes negative", () => {
    expect(buildTrayStatus(input({ showTodayCost: false })).today).toBeNull();
    const s = buildTrayStatus(input({ tokensToday: -5, usdToday: Number.NaN, waiting: -3, bySource: { x: { done: -1, waiting: 2, checked: 1.9 } } }));
    expect(s.today).toEqual({ tokens: 0, usd: 0 });
    expect(s.waiting).toBe(0);
    expect(s.record).toEqual({ labelled: 1, total: 3 });
  });

  it("has nothing to add before the first import, and ignores a bad date", () => {
    const s = buildTrayStatus(input({ rows: [{ id: "claude-code", lastImport: "not a date" }], bySource: {} }));
    expect(s.lastAddedAt).toBeNull();
    expect(s.record).toEqual({ labelled: 0, total: 0 });
  });

  it("carries the export timing from shared/exportDue.ts", () => {
    const s = buildTrayStatus(input());
    const gpt = s.exports.find((e) => e.id === "chatgpt");
    expect(gpt?.due).toBe(true);
    expect(gpt?.daysAgo).toBe(40);
    const claude = s.exports.find((e) => e.id === "claude-ai");
    expect(claude?.due).toBe(false);
    expect(claude?.dueInDays).toBe(22);
    expect(s.exports.find((e) => e.id === "gemini")?.daysAgo).toBeNull();
  });

  it("shows nothing about the record while locked", () => {
    const s = buildTrayStatus(input({ locked: true }));
    expect(s).toEqual({ ...emptyTrayStatus(), locked: true });
  });
});

describe("trayMenu", () => {
  const status = buildTrayStatus(input());
  const menu = trayMenu(status, NOW);

  it("lists the entries in order", () => {
    expect(menu.filter((n) => n.kind !== "separator").map((n) => n.label)).toEqual([
      "Open Cortex",
      "Command bar",
      "Add files…",
      "Live capture",
      "Last added 16 minutes ago",
      "In your record: 65 of 80 sessions labelled",
      "Not anchored yet",
      "Waiting to be labelled: 15",
      "Today: 12,400 tokens, $0.00 billed, $0.19 on your plans at API prices",
      "Connect",
      "Request an export",
      "Due this month",
      "Lock",
      "Settings…",
      "Show what is sent",
      "Quit",
    ]);
  });

  it("ticks Live capture from the status", () => {
    expect(menu.find((n) => n.kind === "check")).toMatchObject({ action: "toggle-live", checked: true });
    expect(trayMenu({ ...status, liveOn: false }, NOW).find((n) => n.kind === "check")).toMatchObject({ checked: false });
  });

  it("has Open first and Quit last, as host actions", () => {
    expect(menu[0]).toMatchObject({ kind: "action", action: "show-window" });
    expect(menu[menu.length - 1]).toMatchObject({ kind: "action", action: "quit" });
  });

  it("never starts or ends with a separator and never doubles one", () => {
    const check = (nodes: readonly TrayNode[]): void => {
      expect(nodes[0]?.kind).not.toBe("separator");
      expect(nodes[nodes.length - 1]?.kind).not.toBe("separator");
      nodes.forEach((n, i) => {
        if (n.kind === "separator") expect(nodes[i + 1]?.kind).not.toBe("separator");
        if (n.kind === "submenu") check(n.items);
      });
    };
    check(menu);
    check(trayMenu(emptyTrayStatus(), NOW));
  });

  it("only forwards real, shipped Cortex commands", () => {
    const ids = trayCommandIds(menu);
    expect([...ids].sort()).toEqual(["add-sources", "connect-agent", "find", "lock", "open-agents", "open-settings", "show-agreement"]);
    for (const id of ids) {
      expect(isCommandId(id)).toBe(true);
      expect(commandAvailable(id)).toBe(true);
    }
  });

  it("offers every archive source under Request an export, and the ones due under Due this month", () => {
    const request = menu.find((n) => n.kind === "submenu" && n.label === "Request an export");
    const due = menu.find((n) => n.kind === "submenu" && n.label === "Due this month");
    const urls = (n: TrayNode | undefined): string[] => (n && n.kind === "submenu" ? n.items.flatMap((i) => (i.kind === "open-url" ? [i.url] : [])) : []);
    expect(urls(request).length).toBe(status.exports.length);
    expect(urls(due)).toEqual(["https://chatgpt.com/#settings/DataControls"]);
    for (const u of urls(request)) expect(isSafeExportUrl(u)).toBe(true);
    expect(labels(menu).some((l) => l.startsWith("ChatGPT: Arrived 40 days ago"))).toBe(true);
  });

  it("says so when nothing is due", () => {
    const quiet = trayMenu({ ...status, exports: status.exports.map((e) => ({ ...e, dueThisMonth: false, due: false })) }, NOW);
    const due = quiet.find((n) => n.kind === "submenu" && n.label === "Due this month");
    expect(due).toMatchObject({ items: [{ kind: "info", label: "Nothing is due this month" }] });
  });

  it("drops an export whose page address is not a plain https page", () => {
    const bad: TrayStatus = { ...status, exports: [{ id: "x", daysAgo: 1, dueInDays: 1, due: false, dueThisMonth: true, exportUrl: "javascript:alert(1)" }] };
    expect(flat(trayMenu(bad, NOW)).some((n) => n.kind === "open-url")).toBe(false);
  });

  it("leaves the price out when the setting hides it, and shows an empty record plainly", () => {
    const l = labels(trayMenu({ ...emptyTrayStatus(), today: null }, NOW));
    expect(l).toContain("Nothing added yet");
    expect(l).toContain("Your record has no sessions yet");
    expect(l.some((x) => x.startsWith("Today"))).toBe(false);
  });

  it("is only Open, a locked line and Quit while locked, with no counts", () => {
    const locked = trayMenu(buildTrayStatus(input({ locked: true })), NOW);
    expect(labels(locked)).toEqual(["Open Cortex", "Cortex is locked", "Quit"]);
    expect(trayTooltip({ ...emptyTrayStatus(), locked: true })).toBe("Cortex · locked");
    expect(trayTooltip(emptyTrayStatus())).toBe("Cortex");
  });

  it("takes every label from the copy catalogue", () => {
    for (const key of Object.keys(COPY.tray)) expect(t(`tray.${key}` as never)).not.toBe(`tray.${key}`);
  });
});

describe("parseHostState (the message from the page is untrusted)", () => {
  const good = { status: buildTrayStatus(input()), prefs: { tray: true, keepRunning: false, quickWindow: true, quickShortcut: "CommandOrControl+Shift+Space" } };

  it("accepts what the renderer sends, unchanged", () => {
    expect(parseHostState(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("rejects anything that is not the shape", () => {
    for (const bad of [null, 5, "x", [], {}, { status: {} }, { status: [], prefs: {} }, { prefs: {}, status: null }]) expect(parseHostState(bad)).toBeNull();
  });

  it("clamps numbers and cuts text", () => {
    const m = parseHostState({ status: { locked: "yes", waiting: -5, record: { labelled: 1e20, total: "9" }, space: `a\u0000b${"x".repeat(500)}`, lastAddedAt: -1, today: { tokens: Number.NaN, usd: -3 } }, prefs: {} });
    expect(m).not.toBeNull();
    expect(m?.status.locked).toBe(false);
    expect(m?.status.waiting).toBe(0);
    expect(m?.status.record).toEqual({ labelled: 1e12, total: 0 });
    expect(m?.status.space.length).toBe(80);
    expect(m?.status.space).not.toContain("\u0000");
    expect(m?.status.lastAddedAt).toBeNull();
    expect(m?.status.today).toEqual({ tokens: 0, usd: 0 });
    expect(m?.prefs).toEqual({ tray: false, keepRunning: false, quickWindow: false, quickShortcut: "CommandOrControl+Shift+Space" });
  });

  it("drops export rows with an unsafe address or id, and caps the list", () => {
    const ok = { id: "claude-ai", daysAgo: 3, dueInDays: 27, due: false, dueThisMonth: false, exportUrl: "https://claude.ai/settings/data-privacy-controls" };
    const rows = [ok, { ...ok, exportUrl: "http://claude.ai/x" }, { ...ok, exportUrl: "file:///C:/secret" }, { ...ok, id: "../x" }, { ...ok, exportUrl: "https://user:pw@claude.ai/" }, "junk", null];
    const m = parseHostState({ status: { exports: rows }, prefs: {} });
    expect(m?.status.exports).toEqual([ok]);
    const many = parseHostState({ status: { exports: Array.from({ length: 200 }, () => ok) }, prefs: {} });
    expect(many?.status.exports.length).toBe(40);
  });

  it("replaces a shortcut that is not an accelerator", () => {
    expect(parseHostState({ status: {}, prefs: { quickShortcut: "rm -rf /" } })?.prefs.quickShortcut).toBe("CommandOrControl+Shift+Space");
    expect(parseHostState({ status: {}, prefs: { quickShortcut: "" } })?.prefs.quickShortcut).toBe("");
  });
});

describe("tray lines from the recordings: anchored, added today, version, spend split", () => {
  const live = (patch: Partial<TrayStatusInput> = {}): TrayNode[] => trayMenu(buildTrayStatus(input(patch)), NOW);

  it("says when the record was last anchored, or that it has not been", () => {
    expect(labels(live({ lastAnchoredAt: NOW - 28 * MIN }))).toContain("Last anchored 28 minutes ago");
    expect(labels(live())).toContain("Not anchored yet");
    expect(labels(live({ lastAnchoredAt: Number.NaN }))).toContain("Not anchored yet");
  });

  it("greys a 'Nothing added today' line under Add files only when nothing came in since midnight", () => {
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    const none = live({ rows: [{ id: "claude-ai", lastImport: new Date(today.getTime() - 60 * MIN).toISOString() }] });
    const i = none.findIndex((n) => n.kind === "command" && n.id === "add-sources");
    expect(none[i + 1]).toEqual({ kind: "info", label: "Nothing added today" });
    const some = live({ rows: [{ id: "claude-ai", lastImport: new Date(NOW - MIN).toISOString() }] });
    expect(labels(some)).not.toContain("Nothing added today");
    expect(labels(live({ rows: [] }))).toContain("Nothing added today");
  });

  it("shows the version at the foot, and 'Up to date' only after a check that found nothing newer", () => {
    expect(updateText({ version: "1.4.0", kind: "current" })).toBe("Up to date (v1.4.0)");
    expect(updateText({ version: "1.4.0", kind: "available", latest: "1.5.0" })).toBe("Update available (v1.5.0)");
    expect(updateText({ version: "1.4.0", kind: "unchecked" })).toBe("Version 1.4.0");
    const unchecked = buildTrayStatus(input({ version: "1.4.0", verdict: null }));
    expect(unchecked.update).toEqual({ version: "1.4.0", kind: "unchecked" });
    expect(buildTrayStatus(input({ version: "1.4.0", verdict: { kind: "unknown", current: "1.4.0" } })).update?.kind).toBe("unchecked");
    expect(buildTrayStatus(input({ version: "1.4.0", verdict: { kind: "current", current: "1.4.0" } })).update).toEqual({ version: "1.4.0", kind: "current" });
    expect(buildTrayStatus(input({ version: "1.4.0", verdict: { kind: "available", current: "1.4.0", latest: "1.5.0" } })).update).toEqual({ version: "1.4.0", kind: "available", latest: "1.5.0" });
    expect(buildTrayStatus(input()).update).toBeNull();
    const ls = labels(live({ version: "1.4.0", verdict: { kind: "current", current: "1.4.0" } }));
    expect(ls[ls.length - 2]).toBe("Up to date (v1.4.0)");
    expect(ls[ls.length - 1]).toBe("Quit");
    expect(labels(live())).not.toContain("Version 1.4.0");
  });

  it("splits the spend into billed and on-plan, with the login and cap state", () => {
    expect(agentsText({ login: "ok", capPct: 70 })).toBe("Agents: login working, stops at 70%");
    expect(agentsText({ login: "auth", capPct: null })).toBe("Agents: login needed, no cap set");
    expect(labels(live({ engine: "ok", capPct: null }))).toContain("Agents: login working, no cap set");
    expect(labels(live())).not.toContain("Agents: login working, no cap set");
  });

  it("carries the new lines through the untrusted message", () => {
    const status = buildTrayStatus(input({ lastAnchoredAt: NOW - MIN, version: "1.4.0", verdict: { kind: "current", current: "1.4.0" }, engine: "limit", capPct: 80 }));
    const back = parseHostState({ status, prefs: { tray: true, keepRunning: false, quickWindow: false, quickShortcut: "" } });
    expect(back?.status).toMatchObject({ lastAnchoredAt: NOW - MIN, update: { version: "1.4.0", kind: "current" }, agents: { login: "limit", capPct: 80 } });
    const hostile = parseHostState({ status: { ...status, lastAnchoredAt: "x", update: { version: " ", kind: "available" }, agents: { login: "root", capPct: 900 } }, prefs: { tray: true } });
    expect(hostile?.status).toMatchObject({ lastAnchoredAt: null, update: null, agents: null });
    const clamped = parseHostState({ status: { ...status, agents: { login: "ok", capPct: 900 } }, prefs: { tray: true } });
    expect(clamped?.status.agents).toEqual({ login: "ok", capPct: 100 });
  });

  it("shows none of it while locked", () => {
    const locked = trayMenu(buildTrayStatus(input({ locked: true, version: "1.4.0", engine: "ok" })), NOW);
    expect(labels(locked)).toEqual(["Open Cortex", "Cortex is locked", "Quit"]);
  });
});
