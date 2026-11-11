/**
 * Shared page scaffolding inside the sheet (CORTEX-UX §5.13): subtitle line, an optional segmented control for
 * the page's tabs (stored in the sheet entry's params so Back restores it), skeleton blocks for ≤ 300 ms while
 * data loads, and the inline error card (icon, one sentence on what failed, what still works, Try again).
 * Also the small helpers every page and reader shares: cancellable loading, date formats bound to the user's
 * settings, the current entry's params, clipboard and file saving through the browser layer, inline change
 * cards with Undo, and keyboard helpers. Owner: E12.
 */
import type { SettingsSection } from "../../shared/settingsTabs";
import type { ComponentChildren, JSX } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import type { App } from "obsidian";
import type { DateFormat } from "../../shared/settings";
import type { SheetEntry } from "../../shared/views";
import type { CortexStore } from "../../state/store";
import { ServicesContext } from "../context";
import { t } from "../copy";
import { openSettingsWindow } from "../openSettings";
import { Icon } from "../primitives/buttons";
import { showMenu, type MenuItemSpec } from "../primitives/menu";
import { fmtDate, fmtDateTime, fmtSpan } from "../valueLabels";

export const SKELETON_MS = 300;

/** Data for a page block: loading (with the previous value while it refreshes), ready, or failed. */
export type Loadable<T> = { state: "loading"; previous?: T } | { state: "ready"; value: T } | { state: "error"; retry: () => void; error?: unknown };

/**
 * Load data for a block. The loader gets an AbortSignal that fires when deps change or the block unmounts;
 * results of an aborted load are dropped, so a slow earlier request never overwrites a newer one. While a
 * reload runs, the previous value stays available (no skeleton flash on every filter keystroke).
 */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): Loadable<T> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Loadable<T>>({ state: "loading" });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const ac = new AbortController();
    setState((prev) => ({ state: "loading", previous: prev.state === "ready" ? prev.value : prev.state === "loading" ? prev.previous : undefined }));
    let pending: Promise<T>;
    try {
      pending = fnRef.current(ac.signal);
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (value) => {
        if (!ac.signal.aborted) setState({ state: "ready", value });
      },
      (error: unknown) => {
        if (!ac.signal.aborted) setState({ state: "error", error, retry: () => setNonce((n) => n + 1) });
      },
    );
    return () => ac.abort();
  }, [...deps, nonce]);
  return state;
}

/** The value of a Loadable when ready (or its previous value while reloading). */
export function loaded<T>(l: Loadable<T>): T | undefined {
  return l.state === "ready" ? l.value : l.state === "loading" ? l.previous : undefined;
}

export function PageFrame(p: { subtitle?: string; tabs?: JSX.Element | null; actions?: JSX.Element | null; children?: ComponentChildren; label?: string }): JSX.Element {
  return (
    <div class="cx-page" aria-label={p.label}>
      {p.actions ? <div class="cx-page-actions">{p.actions}</div> : null}
      {p.tabs ?? null}
      {p.subtitle ? <p class="cx-page-subtitle">{p.subtitle}</p> : null}
      <div class="cx-page-body">{p.children}</div>
    </div>
  );
}

export function Skeleton(p: { rows?: number }): JSX.Element {
  return (
    <div class="cx-skeleton" aria-busy="true" aria-label={t("app.opening")}>
      {Array.from({ length: p.rows ?? 4 }, (_, i) => (
        <span class="cx-skeleton-bar" style={{ width: `${[92, 78, 86, 64, 88, 72][i % 6]}%` }} />
      ))}
    </div>
  );
}

/** Inline error card: icon, the sentence (what failed and what still works), Try again. */
export function ErrorCard(p: { message: string; retry?: () => void }): JSX.Element {
  return (
    <div class="cx-error-card" role="alert">
      <Icon name="warning" />
      <p>{p.message}</p>
      {p.retry ? (
        <button type="button" class="cx-button" onClick={p.retry}>
          {t("app.retry")}
        </button>
      ) : null}
    </div>
  );
}

/** Render a Loadable: skeleton, content (also while refreshing) or the error card. */
export function Load<T>(p: { value: Loadable<T>; failed: string; rows?: number; children: (v: T) => JSX.Element | null }): JSX.Element | null {
  if (p.value.state === "error") return <ErrorCard message={p.failed} retry={p.value.retry} />;
  if (p.value.state === "loading") {
    if (p.value.previous === undefined) return <Skeleton rows={p.rows} />;
    return <div aria-busy="true">{p.children(p.value.previous)}</div>;
  }
  return p.children(p.value.value);
}

/** Relative times for list rows (§1.5): "2 h", "1 d", "6 d", "3 w", then a date. */
export function relTime(ms: number, now: number, fmtDateFn: (ms: number) => string): string {
  if (!Number.isFinite(ms)) return t("agents.none");
  const d = Math.max(0, now - ms);
  const h = d / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(d / 60_000))} min`;
  if (h < 24) return `${Math.round(h)} h`;
  const days = h / 24;
  if (days < 14) return `${Math.round(days)} d`;
  if (days < 56) return `${Math.round(days / 7)} w`;
  return fmtDateFn(ms);
}

// ───────────────────────────── settings-bound formats ─────────────────────────────

export interface Fmt {
  format: DateFormat;
  weekStart: 0 | 1;
  year: number;
  /** A date; `short` drops the current year (lists in this year's context). */
  date(ms: number, short?: boolean): string;
  dateTime(ms: number, short?: boolean): string;
  span(from: number, to: number): string;
  rel(ms: number): string;
}

export function makeFmt(format: DateFormat, weekStart: 0 | 1, now: number = Date.now()): Fmt {
  const year = new Date(now).getFullYear();
  const date = (ms: number, short = false) => fmtDate(ms, format, short ? year : undefined);
  return {
    format,
    weekStart,
    year,
    date,
    dateTime: (ms, short = false) => fmtDateTime(ms, format, short ? year : undefined),
    span: (a, b) => fmtSpan(a, b, format, now),
    rel: (ms) => relTime(ms, now, (x) => date(x, true)),
  };
}

/** Formats bound to Settings › General (date format, week start); defaults outside a Cortex view. */
export function useFmt(): Fmt {
  const s = useContext(ServicesContext);
  const g = s?.settings.value.general;
  return makeFmt(g?.dateFormat ?? "d MMM yyyy", g?.weekStart ?? 1);
}

// ───────────────────────────── sheet params ─────────────────────────────

/** Replace params of the CURRENT page entry (tabs, toggles, sort …) so Back restores them; no-op when unchanged. */
export function setPageParams(store: CortexStore, patch: Readonly<Record<string, string | null | undefined>>): void {
  store.update("ui", (ui) => {
    const cur = ui.sheet.stack[ui.sheet.index];
    if (!cur || cur.kind !== "page") return ui;
    const params: Record<string, string> = { ...(cur.params ?? {}) };
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === "") {
        if (k in params) {
          delete params[k];
          changed = true;
        }
      } else if (params[k] !== v) {
        params[k] = v;
        changed = true;
      }
    }
    if (!changed) return ui;
    const stack: SheetEntry[] = ui.sheet.stack.slice();
    stack[ui.sheet.index] = { kind: "page", route: cur.route, params };
    return { ...ui, sheet: { ...ui.sheet, stack } };
  });
}

/** A param restricted to known values. */
export function pick<V extends string>(value: string | undefined, allowed: readonly V[], fallback: V): V {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as V) : fallback;
}

/**
 * Worker key for a page's statistics. The worker cancels calls latest-wins per (viewId, method); pages run several
 * stats requests at once (rhythm, spine, rows) next to the strip's own, so each purpose gets its own key and only
 * its own stale calls are cancelled. Stats carry no per-view state in the worker.
 */
export function statsKey(viewId: string, purpose: string): string {
  return `${viewId}#${purpose}`;
}

/** Segmented tabs with arrow-key movement (§4.9); the value lives in the sheet entry's params. */
export function PageTabs<V extends string>(p: { value: V; options: readonly { value: V; label: string; badge?: string }[]; onChange(v: V): void; label: string }): JSX.Element {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    const i = p.options.findIndex((o) => o.value === p.value);
    const n = p.options.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    const opt = p.options[next];
    if (!opt) return;
    e.preventDefault();
    p.onChange(opt.value);
    const root = e.currentTarget as HTMLElement | null;
    const buttons = root?.querySelectorAll?.<HTMLElement>("[role=radio]");
    buttons?.[next]?.focus?.();
  };
  return (
    <div class="cx-segmented cx-page-tabs" role="radiogroup" aria-label={p.label} onKeyDown={onKey}>
      {p.options.map((o) => {
        const on = o.value === p.value;
        return (
          <button type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} class={`cx-seg${on ? " is-on" : ""}`} onClick={() => p.onChange(o.value)}>
            {o.label}
            {o.badge ? <span class="cx-seg-badge cx-mono">{o.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A two-state toggle button (Pinned only, Today, Hide No area …) with aria-pressed. */
export function ToggleButton(p: { pressed: boolean; onToggle(v: boolean): void; children: ComponentChildren; icon?: Parameters<typeof Icon>[0]["name"]; title?: string; disabled?: boolean }): JSX.Element {
  return (
    <button type="button" class={`cx-toggle-button${p.pressed ? " is-on" : ""}`} aria-pressed={p.pressed} title={p.title} disabled={p.disabled} onClick={() => p.onToggle(!p.pressed)}>
      {p.icon ? <Icon name={p.icon} /> : null}
      <span>{p.children}</span>
    </button>
  );
}

/** Open an Obsidian menu under the clicked element. */
export function openMenuAt<V extends string>(e: Event, items: readonly MenuItemSpec<V>[], onPick: (v: V) => void): void {
  const anchor = (e.currentTarget ?? e.target) as HTMLElement | null;
  if (!anchor || typeof anchor.getBoundingClientRect !== "function") return;
  showMenu(items, anchor, onPick);
}

/** A picker button (value + chevron) that opens an Obsidian menu (§4.9 Picker). */
export function MenuButton<V extends string>(p: { label: string; value: string; items: () => readonly MenuItemSpec<V>[]; onPick(v: V): void }): JSX.Element {
  return (
    <button type="button" class="cx-select" aria-haspopup="menu" aria-label={p.label} onClick={(e) => openMenuAt(e, p.items(), p.onPick)}>
      <span>{p.value}</span>
      <Icon name="chevron" />
    </button>
  );
}

// ───────────────────────────── changes with Undo ─────────────────────────────

export interface PostedChange {
  summary: string;
  undo?: () => Promise<void>;
  state: "applied" | "undoing" | "undone" | "failed";
}

/**
 * The change card under an action (§4.9 "Change card"): Cortex's own summary and Undo change. Data changes keep
 * Undo for good (corrections can always be undone), so the card stays until the next change replaces it.
 */
export interface ChangeState {
  change: PostedChange | null;
  set(c: PostedChange | null): void;
  post(summary: string, undo?: () => Promise<void>): void;
}

export function useChange(): ChangeState {
  const [change, set] = useState<PostedChange | null>(null);
  const post = useCallback((summary: string, undo?: () => Promise<void>) => set({ summary, undo, state: "applied" }), []);
  return { change, set, post };
}

export function ChangeCard(p: { change: PostedChange | null; onChange(c: PostedChange | null): void }): JSX.Element | null {
  const c = p.change;
  if (!c) return null;
  const undo = async () => {
    if (!c.undo || c.state !== "applied") return;
    p.onChange({ ...c, state: "undoing" });
    try {
      await c.undo();
      p.onChange({ ...c, state: "undone" });
    } catch {
      p.onChange({ ...c, state: "failed" });
    }
  };
  return (
    <div class={`cx-change-card is-${c.state}`} role="status">
      <span class="cx-change-tick" aria-hidden="true">
        {c.state === "undone" ? "↶" : c.state === "failed" ? "!" : "✓"}
      </span>
      <span class="cx-change-summary">{c.state === "failed" ? t("errors.action") : c.summary}</span>
      {c.state === "undone" ? <span class="cx-change-detail cx-mono">{t("changes.undone")}</span> : null}
      {c.undo && c.state === "applied" ? (
        <button type="button" class="cx-text-button" onClick={() => void undo()}>
          {t("toasts.undo")}
        </button>
      ) : null}
    </div>
  );
}

/** A ChangeCard bound to a useChange() state. */
export function ChangeSlot(p: { state: ChangeState }): JSX.Element | null {
  return <ChangeCard change={p.state.change} onChange={p.state.set} />;
}

// ───────────────────────────── platform helpers (browser layer only) ─────────────────────────────

/** Copy text to the clipboard; false when the clipboard is unavailable. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clip = (globalThis as { navigator?: { clipboard?: { writeText?(s: string): Promise<void> } } }).navigator?.clipboard;
    if (clip?.writeText) {
      await clip.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection fallback
  }
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) return false;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = doc.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * Save a file the user asked for (Save image…, Export ledger) through the browser layer: Obsidian's Electron shows
 * its Save dialog for a download link. Nothing is ever written into the vault from here.
 */
export function downloadFile(name: string, mime: string, data: string | Blob): boolean {
  const doc = (globalThis as { document?: Document }).document;
  const urlApi = (globalThis as { URL?: typeof URL }).URL;
  if (!doc?.body || !urlApi?.createObjectURL) return false;
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  const url = urlApi.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = name.replace(/[<>:"|?*\\/]/g, "_").slice(0, 120) || "cortex-export";
  a.style.display = "none";
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => urlApi.revokeObjectURL(url), 30_000);
  return true;
}

/** True when a key event comes from a text field (single-letter keys are ignored there, §8.1). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el !== "object") return false;
  const tag = (el.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}

/** True once `ms` have passed since mount (the reader shows "Opening…" first, then the skeleton). */
export function useElapsed(ms: number): boolean {
  const [done, setDone] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    const id = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(id);
  }, [ms]);
  return done;
}

/** Open Cortex's settings window at a tab or section (§5.27); Privacy and Advanced open the long list. Works in both hosts (ui/openSettings.ts). */
export function openCortexSettings(app: App, section: SettingsSection = "general"): void {
  openSettingsWindow(app, section);
}

/** Run an Obsidian command by id (e.g. "cortex:add-sources"); false when it does not exist. */
export function runObsidianCommand(app: App, id: string): boolean {
  const commands = (app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands;
  return commands?.executeCommandById?.(id) === true;
}
