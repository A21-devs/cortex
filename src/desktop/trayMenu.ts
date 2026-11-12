/**
 * Cortex Desktop's notification-area (tray) menu: a pure description, no Electron, so a test can check it
 * (the same split as menu.ts). tray.ts turns it into an Electron menu.
 *
 * The status lines (what is in the record, what waits, today's tokens, when an export is due) are computed in the
 * renderer, where the services live (`buildTrayStatus`), and sent to the main process over one IPC message
 * ("cortex:host-state"). The main process never reads the record: it only draws what it is told, and
 * `parseHostState` treats the message as untrusted data (numbers clamped, strings cut, export addresses checked).
 *
 * Entry kinds:
 *   command   runs the Cortex command `cortex:<id>` in the page (the same ids as the menu bar and the palette)
 *   action    something the host does: show the window, flip live capture, quit
 *   check     an action with a tick
 *   open-url  opens a provider's own export page in the system browser (https only; nothing is sent)
 *   info      a line of status, greyed out (no click)
 *   separator / submenu
 * Every label comes from ui/copy.ts (`tray`, and `desktopMenu` for the words shared with the menu bar).
 * While Cortex is locked the menu shows no counts, names or costs: only Open Cortex and Quit.
 */
import type { CommandId } from "../plugin/commands";
import type { EngineState } from "../shared/protocol/runner";
import type { UpdateVerdict } from "../shared/update";
import { exportStatuses, isSafeExportUrl, type ExportStatus, type LedgerRow } from "../shared/exportDue";
import { isAccelerator } from "../shared/settingsExt";
import { t } from "../ui/copy";
import { arrivalText, exportName } from "../ui/exportText";

export type TrayHostAction = "show-window" | "toggle-live" | "quit";

export type TrayNode =
  | { kind: "command"; id: CommandId; label: string }
  | { kind: "action"; action: TrayHostAction; label: string }
  | { kind: "check"; action: "toggle-live"; label: string; checked: boolean }
  | { kind: "open-url"; url: string; label: string }
  | { kind: "info"; label: string }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; items: TrayNode[] };

/** Where Cortex stands with its own updates: only a check the person ran counts, so "unchecked" never claims "up to date". */
export interface TrayUpdate {
  version: string;
  kind: "current" | "available" | "unchecked";
  /** The newer version, when one is available. */
  latest?: string;
}

/** The agents' login state and the plan cap in force (the lowest share an agent stops at; null = none set). */
export interface TrayAgents {
  login: EngineState;
  capPct: number | null;
}

const ENGINE_STATES: readonly EngineState[] = ["ok", "offline", "auth", "missing", "limit", "unsafe"];

/** One archive source's export timing, as the sources list works it out (shared/exportDue.ts). */
export type TrayExport = Pick<ExportStatus, "id" | "daysAgo" | "dueInDays" | "due" | "dueThisMonth" | "exportUrl">;

/** What the tray menu and the quick window show; computed in the renderer, sent to the main process. */
export interface TrayStatus {
  /** The lock or a privacy blank is on: the menu shows nothing about the record. */
  locked: boolean;
  /** Live capture (the browser add-on's receiver) is on. */
  liveOn: boolean;
  /** The newest import across every source, epoch milliseconds; null before the first. */
  lastAddedAt: number | null;
  /** Something was imported since midnight (local time). */
  addedToday: boolean;
  /** When the seal chain was last anchored (dated outside this computer), epoch milliseconds; null before the first. */
  lastAnchoredAt: number | null;
  /** The installed version and what the last update check found; null when the host does not know its version. */
  update: TrayUpdate | null;
  agents: TrayAgents | null;
  /** Sessions with a label (done or checked) out of every session in the record. */
  record: { labelled: number; total: number };
  /** Conversations waiting for the labelling agent. */
  waiting: number;
  /** Today's tokens and what they would cost at API list prices; null when the setting hides it. */
  today: { tokens: number; usd: number } | null;
  exports: TrayExport[];
  /** The name of the area the stage shows ("" while locked); the quick window's title. */
  space: string;
}

/** The launcher settings the main process needs (shared/settingsExt.ts, `launcher`). */
export interface TrayPrefs {
  tray: boolean;
  keepRunning: boolean;
  quickWindow: boolean;
  quickShortcut: string;
}

export interface HostState {
  status: TrayStatus;
  prefs: TrayPrefs;
}

export const DEFAULT_PREFS: Readonly<TrayPrefs> = { tray: true, keepRunning: false, quickWindow: false, quickShortcut: "CommandOrControl+Shift+Space" };

export function emptyTrayStatus(): TrayStatus {
  return { locked: false, liveOn: false, lastAddedAt: null, addedToday: false, lastAnchoredAt: null, update: null, agents: null, record: { labelled: 0, total: 0 }, waiting: 0, today: null, exports: [], space: "" };
}

// ───────────────────────────── building the status (renderer side) ─────────────────────────────

export interface TrayStatusInput {
  locked: boolean;
  liveOn: boolean;
  /** The sources list: the id and the last import (ISO text) of each row. */
  rows: readonly (LedgerRow & { lastImport?: string | undefined })[];
  /** Queues by source: done, waiting and checked conversations. */
  bySource: Readonly<Record<string, { done: number; waiting: number; checked: number }>>;
  /** Conversations waiting for a label (the queue's own count). */
  waiting: number;
  tokensToday: number;
  usdToday: number;
  showTodayCost: boolean;
  /** Per-source cadence overrides (settings.record.exportEveryBySource). */
  cadenceOverrides: Readonly<Record<string, unknown>>;
  now: number;
  space: string;
  lastAnchoredAt?: number | null;
  /** The installed version and the verdict of the last update check the person ran (null: none yet). */
  version?: string;
  verdict?: UpdateVerdict | null;
  engine?: EngineState;
  capPct?: number | null;
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Pure: the status lines from the shared state. Locked hides every figure. */
export function buildTrayStatus(i: TrayStatusInput): TrayStatus {
  if (i.locked) return { ...emptyTrayStatus(), locked: true };
  let labelled = 0;
  let total = 0;
  for (const q of Object.values(i.bySource)) {
    labelled += count(q.done) + count(q.checked);
    total += count(q.done) + count(q.checked) + count(q.waiting);
  }
  let last: number | null = null;
  for (const r of i.rows) {
    const at = r.lastImport ? Date.parse(r.lastImport) : Number.NaN;
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  const midnight = new Date(i.now);
  midnight.setHours(0, 0, 0, 0);
  const addedToday = last !== null && last >= midnight.getTime();
  const anchored = i.lastAnchoredAt;
  const update: TrayUpdate | null = !i.version
    ? null
    : i.verdict?.kind === "current"
      ? { version: i.version, kind: "current" }
      : i.verdict?.kind === "available"
        ? { version: i.version, kind: "available", latest: i.verdict.latest }
        : { version: i.version, kind: "unchecked" };
  const statuses = exportStatuses(i.rows, i.now, i.cadenceOverrides);
  return {
    locked: false,
    liveOn: i.liveOn,
    lastAddedAt: last,
    addedToday,
    lastAnchoredAt: typeof anchored === "number" && Number.isFinite(anchored) && anchored > 0 ? anchored : null,
    update,
    agents: i.engine ? { login: i.engine, capPct: typeof i.capPct === "number" && Number.isFinite(i.capPct) ? i.capPct : null } : null,
    record: { labelled, total },
    waiting: count(i.waiting),
    today: i.showTodayCost ? { tokens: count(i.tokensToday), usd: Number.isFinite(i.usdToday) && i.usdToday > 0 ? i.usdToday : 0 } : null,
    exports: statuses.map((s) => ({ id: s.id, daysAgo: s.daysAgo, dueInDays: s.dueInDays, due: s.due, dueThisMonth: s.dueThisMonth, exportUrl: s.exportUrl })),
    space: i.space,
  };
}

// ───────────────────────────── wording ─────────────────────────────

const nf = new Intl.NumberFormat("en-GB");
const fmt = (n: number): string => nf.format(Math.max(0, Math.round(n)));

/** "just now", "16 minutes ago", "3 hours ago", "yesterday", "5 days ago". A future time reads as "just now". */
export function agoText(then: number, now: number): string {
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return t("tray.agoNow");
  if (min === 1) return t("tray.agoMinute");
  if (min < 60) return t("tray.agoMinutes", { n: min });
  const hours = Math.floor(min / 60);
  if (hours === 1) return t("tray.agoHour");
  if (hours < 24) return t("tray.agoHours", { n: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t("tray.agoDay") : t("tray.agoDays", { n: days });
}

/** "$42.26"; whole dollars from $100 up. */
export function usdText(usd: number): string {
  const v = Number.isFinite(usd) && usd > 0 ? usd : 0;
  return v >= 100 ? `$${fmt(v)}` : `$${v.toFixed(2)}`;
}

/** "Today: 12,400 tokens, about $0.19 at API prices"; a cost that rounds to nothing leaves the price out. */
export function todayText(today: { tokens: number; usd: number }): string {
  if (today.tokens <= 0) return t("tray.todayNone");
  if (today.usd < 0.005) return t("tray.todayTokens", { tokens: fmt(today.tokens) });
  return t("tray.today", { tokens: fmt(today.tokens), billed: usdText(0), price: usdText(today.usd) });
}

const LOGIN_COPY: Readonly<Record<EngineState, "tray.loginOk" | "tray.loginOffline" | "tray.loginAuth" | "tray.loginMissing" | "tray.loginLimit" | "tray.loginUnsafe">> = {
  ok: "tray.loginOk",
  offline: "tray.loginOffline",
  auth: "tray.loginAuth",
  missing: "tray.loginMissing",
  limit: "tray.loginLimit",
  unsafe: "tray.loginUnsafe",
};

/** "Agents: login working, stops at 70%": the login state and the cap. Cortex never bills: it runs on the person's own plan. */
export function agentsText(a: TrayAgents): string {
  return t("tray.agents", { login: t(LOGIN_COPY[a.login]), cap: a.capPct === null ? t("tray.capNone") : t("tray.capAt", { pct: a.capPct }) });
}

/** The foot line: "Up to date (v1.2.0)" only after a check the person ran; otherwise just the version. */
export function updateText(u: TrayUpdate): string {
  if (u.kind === "current") return t("tray.upToDate", { version: u.version });
  if (u.kind === "available") return t("tray.updateAvailable", { version: u.latest ?? u.version });
  return t("tray.versionOnly", { version: u.version });
}

export function trayTooltip(status: TrayStatus): string {
  return status.locked ? t("tray.tooltipLocked") : t("tray.tooltip");
}

// ───────────────────────────── the menu ─────────────────────────────

const SEP: TrayNode = { kind: "separator" };

function exportLabel(s: TrayExport): string {
  return t("tray.exportLine", { source: exportName(s.id), when: arrivalText(s) });
}

/** The whole tray menu. `now` only decides the "last added … ago" wording. */
export function trayMenu(status: TrayStatus, now: number): TrayNode[] {
  const open: TrayNode = { kind: "action", action: "show-window", label: t("tray.open") };
  const quit: TrayNode = { kind: "action", action: "quit", label: t("desktopMenu.quit") };
  if (status.locked) return [open, { kind: "info", label: t("tray.locked") }, SEP, quit];
  const exports = status.exports.filter((e) => isSafeExportUrl(e.exportUrl));
  const due = exports.filter((e) => e.dueThisMonth).sort((a, b) => (a.dueInDays ?? 0) - (b.dueInDays ?? 0));
  const lines: TrayNode[] = [
    { kind: "info", label: status.lastAddedAt === null ? t("tray.lastAddedNone") : t("tray.lastAdded", { ago: agoText(status.lastAddedAt, now) }) },
    { kind: "info", label: status.record.total > 0 ? t("tray.record", { n: fmt(status.record.labelled), m: fmt(status.record.total) }) : t("tray.recordNone") },
    { kind: "info", label: status.lastAnchoredAt === null ? t("tray.lastAnchoredNone") : t("tray.lastAnchored", { ago: agoText(status.lastAnchoredAt, now) }) },
    { kind: "info", label: t("tray.waiting", { n: fmt(status.waiting) }) },
  ];
  if (status.today) lines.push({ kind: "info", label: todayText(status.today) });
  if (status.agents) lines.push({ kind: "info", label: agentsText(status.agents) });
  return [
    open,
    { kind: "command", id: "find", label: t("tray.commandBar") },
    SEP,
    { kind: "command", id: "add-sources", label: t("tray.addFiles") },
    ...(status.addedToday ? [] : [{ kind: "info", label: t("tray.addedNone") } as TrayNode]),
    SEP,
    { kind: "check", action: "toggle-live", label: t("tray.liveCapture"), checked: status.liveOn },
    ...lines,
    SEP,
    {
      kind: "submenu",
      label: t("desktopMenu.connect"),
      items: [
        { kind: "command", id: "connect-agent", label: t("desktopMenu.connectClaude") },
        { kind: "command", id: "open-agents", label: t("desktopMenu.connectOthers") },
      ],
    },
    {
      kind: "submenu",
      label: t("tray.requestExport"),
      items: exports.map((e): TrayNode => ({ kind: "open-url", url: e.exportUrl, label: exportLabel(e) })),
    },
    {
      kind: "submenu",
      label: t("tray.dueThisMonth"),
      items: due.length > 0 ? due.map((e): TrayNode => ({ kind: "open-url", url: e.exportUrl, label: exportLabel(e) })) : [{ kind: "info", label: t("tray.dueNone") }],
    },
    SEP,
    { kind: "command", id: "lock", label: t("desktopMenu.lock") },
    { kind: "command", id: "open-settings", label: t("desktopMenu.settings") },
    { kind: "command", id: "show-agreement", label: t("tray.show") },
    ...(status.update ? [SEP, { kind: "info", label: updateText(status.update) } as TrayNode] : []),
    SEP,
    quit,
  ];
}

/** Every Cortex command id the menu can run (main.ts only forwards these to the page). */
export function trayCommandIds(nodes: readonly TrayNode[]): CommandId[] {
  const out: CommandId[] = [];
  for (const n of nodes) {
    if (n.kind === "command") out.push(n.id);
    else if (n.kind === "submenu") out.push(...trayCommandIds(n.items));
  }
  return out;
}

// ───────────────────────────── the message from the renderer ─────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, hi = 1e12): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(0, Math.floor(v))) : 0);
const bool = (v: unknown): boolean => v === true;
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

function parseExport(v: unknown): TrayExport | null {
  if (!isRecord(v)) return null;
  const id = typeof v.id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(v.id) ? v.id : null;
  const url = typeof v.exportUrl === "string" && isSafeExportUrl(v.exportUrl) ? v.exportUrl : null;
  if (!id || !url) return null;
  const days = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? Math.max(-100_000, Math.min(100_000, Math.round(x))) : null);
  return { id, daysAgo: v.daysAgo === null ? null : days(v.daysAgo), dueInDays: v.dueInDays === null ? null : days(v.dueInDays), due: bool(v.due), dueThisMonth: bool(v.dueThisMonth), exportUrl: url };
}

function parseUpdate(v: unknown): TrayUpdate | null {
  if (!isRecord(v)) return null;
  const version = text(v.version, 40);
  if (version === "") return null;
  const latest = text(v.latest, 40);
  if (v.kind === "available" && latest !== "") return { version, kind: "available", latest };
  return { version, kind: v.kind === "current" ? "current" : "unchecked" };
}

function parseAgents(v: unknown): TrayAgents | null {
  if (!isRecord(v)) return null;
  const login = ENGINE_STATES.find((e) => e === v.login);
  if (!login) return null;
  return { login, capPct: typeof v.capPct === "number" && Number.isFinite(v.capPct) ? Math.min(100, Math.max(0, Math.round(v.capPct))) : null };
}

/** The message "cortex:host-state" is untrusted: anything that does not fit is dropped or clamped. */
export function parseHostState(raw: unknown): HostState | null {
  if (!isRecord(raw) || !isRecord(raw.status) || !isRecord(raw.prefs)) return null;
  const s = raw.status;
  const p = raw.prefs;
  const rec = isRecord(s.record) ? s.record : {};
  const today = isRecord(s.today) ? { tokens: num(s.today.tokens), usd: typeof s.today.usd === "number" && Number.isFinite(s.today.usd) ? Math.min(1e9, Math.max(0, s.today.usd)) : 0 } : null;
  const exports = Array.isArray(s.exports) ? s.exports.slice(0, 40).map(parseExport).filter((e): e is TrayExport => e !== null) : [];
  const shortcut = typeof p.quickShortcut === "string" ? p.quickShortcut.trim() : DEFAULT_PREFS.quickShortcut;
  return {
    status: {
      locked: bool(s.locked),
      liveOn: bool(s.liveOn),
      lastAddedAt: typeof s.lastAddedAt === "number" && Number.isFinite(s.lastAddedAt) && s.lastAddedAt > 0 ? s.lastAddedAt : null,
      addedToday: bool(s.addedToday),
      lastAnchoredAt: typeof s.lastAnchoredAt === "number" && Number.isFinite(s.lastAnchoredAt) && s.lastAnchoredAt > 0 ? s.lastAnchoredAt : null,
      update: parseUpdate(s.update),
      agents: parseAgents(s.agents),
      record: { labelled: num(rec.labelled), total: num(rec.total) },
      waiting: num(s.waiting),
      today,
      exports,
      space: text(s.space, 80),
    },
    prefs: { tray: bool(p.tray), keepRunning: bool(p.keepRunning), quickWindow: bool(p.quickWindow), quickShortcut: shortcut === "" || isAccelerator(shortcut) ? shortcut : DEFAULT_PREFS.quickShortcut },
  };
}

/** What a click in the tray menu asks the renderer to do besides a command. */
export function isTrayHostAction(v: unknown): v is TrayHostAction {
  return v === "show-window" || v === "toggle-live" || v === "quit";
}
