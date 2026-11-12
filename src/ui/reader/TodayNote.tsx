/**
 * Today's note: choosing Today in the rail opens the day's note in the reader column. It reads the vault note that
 * Obsidian's Daily notes settings name (folder and date format), shows "Opening today's note..." while it loads, and
 * links to the list of today's entries (Read's Today filter). Nothing is written here: a missing note is created by
 * Obsidian's own "daily-notes" command, and editing happens in Obsidian's editor ("Open in editor").
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Component, MarkdownRenderer, type App } from "obsidian";
import { dailyNotePath, DEFAULT_DAILY_OPTIONS, parseDailyOptions, type DailyNoteOptions } from "../../shared/dailyNote";
import { showTodayEntries } from "../../state/actions";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { runObsidianCommand, useLoad } from "../pages/PageFrame";
import { openInObsidian } from "./readerKit";

/** The most text rendered at once; a day's note is short, this only guards a pasted-in log. */
export const TODAY_CHARS = 20000;

export type TodayData = { kind: "note"; path: string; text: string } | { kind: "none"; path: string | null } | { kind: "sample" };

type VaultLike = { getAbstractFileByPath?(p: string): unknown; cachedRead?(f: unknown): Promise<string>; adapter?: { read?(p: string): Promise<string> } };

/** Daily notes' folder and format: the plugin's live options when Obsidian has them, else its settings file, else the defaults. */
export async function readDailyOptions(app: App): Promise<DailyNoteOptions> {
  const live = (app as unknown as { internalPlugins?: { getPluginById?(id: string): { instance?: { options?: unknown } } | undefined } }).internalPlugins?.getPluginById?.("daily-notes")?.instance?.options;
  if (live && typeof live === "object") return parseDailyOptions(live);
  try {
    const raw = await (app.vault as unknown as VaultLike).adapter?.read?.(".obsidian/daily-notes.json");
    if (typeof raw === "string") return parseDailyOptions(JSON.parse(raw));
  } catch {
    // No settings file: Obsidian's defaults apply.
  }
  return DEFAULT_DAILY_OPTIONS;
}

/** Whether Obsidian's Daily notes command exists here (Cortex Desktop has none, so it offers no Create button). */
export function canCreateDaily(app: App): boolean {
  const commands = (app as unknown as { commands?: { commands?: Record<string, unknown> } }).commands?.commands;
  return commands !== undefined && "daily-notes" in commands;
}

/** Find and read the day's note; never creates anything. */
export async function loadToday(app: App, sandbox: boolean, now: Date): Promise<TodayData> {
  if (sandbox) return { kind: "sample" };
  const path = dailyNotePath(await readDailyOptions(app), now);
  if (path === null) return { kind: "none", path: null };
  const vault = app.vault as unknown as VaultLike;
  const file = vault.getAbstractFileByPath?.(path);
  if (!file || !vault.cachedRead) return { kind: "none", path };
  return { kind: "note", path, text: (await vault.cachedRead(file)).slice(0, TODAY_CHARS) };
}

export function TodayNote(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const sandbox = s.sandbox.value;
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const data = useLoad((_signal) => loadToday(s.app, sandbox, new Date()), [sandbox, nonce]);
  const host = useRef<HTMLDivElement>(null);
  const note = data.state === "ready" && data.value.kind === "note" ? data.value : null;

  useEffect(() => {
    const el = host.current;
    if (!el || !note) return;
    const ComponentCtor = Component as unknown as (new () => Component) | undefined;
    const comp = typeof ComponentCtor === "function" ? new ComponentCtor() : null;
    comp?.load();
    (el as unknown as { empty?(): void }).empty?.();
    void MarkdownRenderer.render(s.app, note.text, el, note.path, comp as Component).catch(() => undefined);
    return () => {
      comp?.unload();
      (el as unknown as { empty?(): void }).empty?.();
    };
  }, [note?.text, note?.path]);

  const create = () => {
    if (!runObsidianCommand(s.app, "daily-notes")) return setStatus(t("errors.action"));
    setStatus(null);
    // Obsidian creates the note from its template and opens it; read it again once the file is there.
    setTimeout(() => setNonce((n) => n + 1), 800);
  };

  return (
    <article class="cx-reader cx-today-note" aria-busy={data.state === "loading"}>
      <div class="cx-reader-head">
        <h3 class="cx-reader-title">{t("nav.today")}</h3>
        {note ? <p class="cx-note">{note.path}</p> : null}
        <div class="cx-row-buttons">
          <button type="button" class="cx-text-button cx-today-entries" onClick={() => showTodayEntries(leaf.store)}>
            {t("reader.todayEntries")}
          </button>
          {note ? (
            <button type="button" class="cx-text-button" onClick={() => void (openInObsidian(s.app, note.path, "tab") || setStatus(t("reader.openFailed")))}>
              {t("reader.openInEditor")}
            </button>
          ) : null}
        </div>
      </div>
      {status ? (
        <p class="cx-note" role="status">
          {status}
        </p>
      ) : null}
      {data.state === "loading" ? (
        <p class="cx-note cx-today-loading" role="status">
          {t("nav.todayOpening")}
        </p>
      ) : data.state === "error" ? (
        <p class="cx-note" role="status">
          {t("reader.todayFailed")}
        </p>
      ) : data.value.kind === "sample" ? (
        <p class="cx-note">{t("reader.todayNoWrite")}</p>
      ) : data.value.kind === "none" ? (
        <>
          <p class="cx-note">{t("reader.todayNoNote")}</p>
          {canCreateDaily(s.app) ? (
            <button type="button" class="cx-text-button cx-today-create" onClick={create}>
              {t("reader.todayCreate")}
            </button>
          ) : null}
        </>
      ) : (
        <div class="cx-peek-body markdown-rendered cx-today-body" ref={host} />
      )}
    </article>
  );
}
