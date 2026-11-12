/**
 * Add sources (CORTEX-UX §5.26, after the first-run step): an Obsidian Modal, 720 px. Title "Add sources";
 * subtitle; a 46 px drop zone ("Drop an export (.zip or folder) here…", which runs import.inspect and routes to
 * the matching row); then one row per source — 32 px icon tile, name + status pill, a detail line that also states
 * the storage folder once imported, and a control:
 *  - This vault's notes (toggle; "‹n› notes · ‹m› reference notes hidden by default");
 *  - Documents in .raw/ (toggle; Roblox creator docs as reference, skip YAML, skip the API dump);
 *  - Claude Code (Options; detected projects folder; watch, subagents, tool output, thinking, project → area; the
 *    retention note; can't-read error);
 *  - Claude.ai export and ChatGPT export (Import… / Import newer… → Checking the export… → preview → Import →
 *    done line; not-an-export and older-export errors);
 *  - Gemini (Google Takeout) (Choose…; preview with grouping note; HTML-Takeout and no-activity errors);
 *  - A folder of your own (Choose folder… → Whose words are these? Mine · Another person's · Ask per file → file
 *    types → watch → Import).
 * Footer: shield + "Assistant replies from ChatGPT and Gemini are never sent to a model. Change this in Settings ›
 * Privacy." and Done. Paths come from pickPath.ts. Imports run through SourcesService. Owner: E3 (flows), E11
 * (shell).
 */
import { Modal, Notice, type App } from "obsidian";
import { CortexError } from "../../shared/errors";
import { dueThisMonth, exportSources, exportStatuses, type ExportSource, type ExportStatus } from "../../shared/exportDue";
import type { InspectResult, SourceSelector } from "../../shared/protocol/runner";
import { SPACES } from "../../shared/spaces";
import type { CortexSettings, FolderSourceSetting, SpeakerChoice } from "../../shared/settings";
import type { SpaceId } from "../../shared/types";
import type { CortexServices, SourceRow, SourcesService } from "../../plugin/services";
import { SETTINGS_COPY, t } from "../copy";
import { openPage } from "../../state/actions";
import { arrivalText, exportHowTo, exportName, openExportPage } from "../exportText";
import { isAbsoluteTypedPath, pathOfDroppedFile, showOpenDialog, type PickKind } from "./pickPath";

/** What the dialog needs beyond SourcesService for "Ask per file" (RFC E3 asks to move these into the contract). */
export interface SourcesServiceExt extends SourcesService {
  listFolderFiles(root: string, extensions: readonly string[]): Promise<string[]>;
  saveFolderSpeakers(folderId: string, files: Record<string, "you" | "other">): Promise<void>;
}

export const ADD_SOURCE_ROWS = ["vault", "raw", "claudeCode", "claudeAi", "chatgpt", "gemini", "folder"] as const;
export type AddSourceRow = (typeof ADD_SOURCE_ROWS)[number];

/** File types offered for a folder (FOLDER_FILE_TYPES in importers/folders.ts). */
const FILE_TYPES = ["md", "txt", "code", "json", "csv", "html"] as const;
const CODE_EXTENSIONS = ["py", "js", "ts", "tsx", "jsx", "lua", "luau", "cs", "java", "c", "cpp", "h", "go", "rs", "sh", "ps1", "css"];
const EXPORT_ROWS = { claudeAi: "claude-ai", chatgpt: "chatgpt", gemini: "gemini" } as const;
type ExportRow = keyof typeof EXPORT_ROWS;
/** Ledger id → sheet row for the archive sources that have a fixed row; any other archive source gets a generic row. */
const ROW_OF_SOURCE: Readonly<Record<string, AddSourceRow>> = { "claude-ai": "claudeAi", chatgpt: "chatgpt", gemini: "gemini" };

const PANEL_ON = "grid-column:2 / span 2;display:flex;gap:6px;flex-direction:column";
const PANEL_OFF = "grid-column:2 / span 2;display:none";

/** Other coding agents (opt-in): the settings key, the sheet's row id and its wording. */
const AGENT_ROWS = [
  { id: "codex-cli", key: "codexCli", name: "addSources.codexCli", how: "addSources.howCodexCli" },
  { id: "gemini-cli", key: "geminiCli", name: "addSources.geminiCli", how: "addSources.howGeminiCli" },
  { id: "cursor", key: "cursor", name: "addSources.cursor", how: "addSources.howCursor" },
] as const;

/** Strings the shared catalogue does not carry. */
const LOCAL = {
  importing: "Importing…",
  imported: "Imported {n} conversations. {skipped} were already here and were skipped.",
  importedFiles: "Imported {n} entries.",
  unknown: "Cortex couldn't tell which service this came from. Choose the export's .zip or folder.",
  typePathHint: "Paste the full path, then press Enter.",
  couldntImport: "Couldn't import this. Nothing was changed.",
  noFiles: "No files of these types in this folder.",
  allMine: "All mine",
  allAnother: "All another person's",
  skipFile: "Leave out",
  notSample: "The sample record is showing; nothing is imported.",
  settingFailed: "Couldn't save this setting. Try again.",
} as const;

/** The file extensions a set of chosen file types stands for (importers/folders.ts expandFileTypes). */
export function extensionsOfTypes(types: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of types) {
    if (k === "code") CODE_EXTENSIONS.forEach((e) => out.add(e));
    else if (k === "md") ["md", "markdown"].forEach((e) => out.add(e));
    else if (k === "html") ["html", "htm"].forEach((e) => out.add(e));
    else out.add(k);
  }
  return [...out];
}

/** "3 min", "2 h", "5 days": how long ago, for the Claude Code detail line. */
export function agoText(iso: string | undefined, now = Date.now()): string {
  const t0 = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t0)) return "–";
  const m = Math.max(0, Math.round((now - t0) / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}

function folderLabel(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function newFolderId(): string {
  return `f${Math.random().toString(36).slice(2, 10)}`;
}

interface Row {
  root: HTMLElement;
  pill: HTMLElement;
  detail: HTMLElement;
  /** One-line how-to under the name. */
  how: HTMLElement;
  /** "Arrived 8 days ago · due in 22 days" for archive sources. */
  came: HTMLElement;
  control: HTMLElement;
  panel: HTMLElement;
  open: boolean;
}

export class AddSourcesModal extends Modal {
  private readonly rows = new Map<string, Row>();
  private zoneNote!: HTMLElement;
  private dueBox!: HTMLElement;
  private busy = new Set<string>();
  private rowData = new Map<string, SourceRow>();
  /** Claude Code row extras: the first-import progress ("Reading ‹n› sessions…") and the read errors. */
  private ccProgress: { wrap: HTMLElement; text: HTMLElement; bar: HTMLProgressElement } | null = null;
  private ccErrors: HTMLElement | null = null;
  private ccWhere = "";
  private stopActivity: (() => void) | null = null;
  private wasImporting = false;
  private importing: { done: number; total?: number; kept?: number } | undefined;
  /** Docked as a page: Done puts the page away instead of closing a dialog. */
  private onDone: (() => void) | null = null;
  private stopResume: (() => void) | null = null;
  private resumeNote: HTMLElement | null = null;
  private resumeAgain: HTMLElement | null = null;

  constructor(app: App, private readonly services: CortexServices) {
    super(app);
  }

  /** Build into a page's own container instead of a dialog: `done` is what the Done button does. */
  dock(done: () => void): this {
    this.onDone = done;
    return this;
  }

  override onOpen(): void {
    this.modalEl.addClass("cx-modal", "cx-add-sources-modal");
    this.titleEl.setText(t("addSources.title"));
    this.contentEl.createEl("p", { text: t("addSources.subtitle"), cls: "cx-modal-subtitle" });
    const zone = this.contentEl.createDiv({ cls: "cx-drop-zone", text: t("addSources.drop") });
    zone.createDiv({ text: t("addSources.dropHint"), cls: "cx-drop-hint" });
    const actions = this.contentEl.createDiv({ cls: "cx-add-actions" });
    actions.setAttr("style", "display:flex;gap:8px;margin-top:8px");
    actions.createEl("button", { text: t("addSources.chooseFiles"), cls: "cx-choose-files" }).addEventListener("click", () => void this.pick(this.zoneNote, "zip-or-folder", (p) => void this.route(p)));
    actions.createEl("button", { text: t("addSources.openFolder"), cls: "cx-open-folder" }).addEventListener("click", () => void this.pick(this.zoneNote, "folder", (p) => void this.routeFolder(p)));
    this.contentEl.createEl("p", { text: t("add.nothingLeaves"), cls: "cx-modal-subtitle cx-privacy-line" });
    this.zoneNote = this.contentEl.createDiv({ cls: "cx-modal-subtitle" });
    this.dueBox = this.contentEl.createDiv({ cls: "cx-due-group" });
    this.buildResume(this.contentEl);
    zone.addEventListener("dragover", (e) => e.preventDefault());
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      const p = f ? pathOfDroppedFile(f) : null;
      if (p) void this.route(p);
      else this.askForPath(this.zoneNote, "zip-or-folder", (typed) => void this.route(typed));
    });
    zone.addEventListener("click", () => void this.pick(this.zoneNote, "zip-or-folder", (p) => void this.route(p)));
    const list = this.contentEl.createDiv({ cls: "cx-source-rows" });
    list.setAttr("style", "display:flex;flex-direction:column;gap:8px;margin-top:12px");
    const names: Record<AddSourceRow, string> = {
      vault: t("addSources.vault"),
      raw: t("addSources.raw"),
      claudeCode: t("addSources.claudeCode"),
      claudeAi: t("addSources.claudeAi"),
      chatgpt: t("addSources.chatgpt"),
      gemini: t("addSources.gemini"),
      folder: t("addSources.folder"),
    };
    for (const id of ADD_SOURCE_ROWS) this.rows.set(id, this.buildRow(list, id, names[id]));
    // Archive sources an importer package adds get a generic row (name, how-to, arrival line, Request an export, Choose…).
    for (const src of exportSources()) if (!ROW_OF_SOURCE[src.id]) this.rows.set(src.id, this.buildRow(list, src.id, exportName(src.id)));
    list.createEl("strong", { text: t("addSources.agentsHeading") }).setAttr("style", "margin-top:8px");
    list.createDiv({ text: t("addSources.agentsNote"), cls: "cx-modal-subtitle" });
    for (const a of AGENT_ROWS) this.rows.set(a.id, this.buildRow(list, a.id, t(a.name)));
    this.buildVault();
    this.buildRaw();
    this.buildClaudeCode();
    for (const id of ["claudeAi", "chatgpt", "gemini"] as const) this.buildExport(id);
    for (const src of exportSources()) if (!ROW_OF_SOURCE[src.id]) this.buildGenericExport(src);
    this.buildHowTos();
    this.buildAgents();
    this.buildFolder();
    const foot = this.contentEl.createDiv({ cls: "cx-modal-footer" });
    foot.createEl("p", { text: `🛡 ${t("addSources.footer")}` });
    foot.createEl("button", { text: t("addSources.done"), cls: "mod-cta" }).addEventListener("click", () => (this.onDone ? this.onDone() : this.close()));
    void this.refresh();
    // The first import is read in the background; its progress shows on the Claude Code row while it runs.
    this.stopActivity = this.services.shared?.slices?.activity?.subscribe?.((a) => this.onActivity(a.importing)) ?? null;
  }

  override onClose(): void {
    this.stopResume?.();
    this.stopResume = null;
    this.stopActivity?.();
    this.stopActivity = null;
    this.ccProgress = null;
    this.ccErrors = null;
    this.contentEl.empty();
    this.rows.clear();
  }

  // ───────────── your resume ─────────────

  /** "Your resume": one file, kept apart from the record, and a claims check queued for Checks. */
  private buildResume(parent: HTMLElement): void {
    const resume = this.services.resume;
    if (!resume) return;
    const box = parent.createDiv({ cls: "cx-resume" });
    box.setAttr("style", "display:flex;flex-direction:column;gap:6px;margin-top:12px");
    box.createEl("strong", { text: t("add.resumeHeading") });
    box.createDiv({ text: t("add.resumeBody"), cls: "cx-modal-subtitle" });
    const row = box.createDiv({ cls: "cx-resume-row" });
    row.setAttr("style", "display:flex;gap:8px;align-items:center;flex-wrap:wrap");
    const add = row.createEl("button", { text: t("add.resumeButton"), cls: "cx-resume-add" });
    this.resumeAgain = row.createEl("button", { text: t("add.resumeAgain"), cls: "cx-resume-again" });
    this.resumeAgain.setAttr("style", "display:none");
    this.resumeAgain.addEventListener("click", () => void resume.check());
    this.resumeNote = box.createDiv({ cls: "cx-modal-subtitle cx-resume-note" });
    const take = (file: string): void => {
      this.resumeNote?.setText(t("add.resumeChecking"));
      void resume.add(file).catch(() => this.resumeNote?.setText(t("add.resumeBad")));
    };
    add.addEventListener("click", () => void this.pick(this.resumeNote as HTMLElement, "resume", take));
    this.stopResume = resume.version.subscribe(() => void this.refreshResume());
  }

  private async refreshResume(): Promise<void> {
    const note = this.resumeNote;
    if (!note) return;
    let st: Awaited<ReturnType<NonNullable<CortexServices["resume"]>["status"]>> = null;
    try {
      st = (await this.services.resume?.status()) ?? null;
    } catch {
      st = null;
    }
    if (this.resumeNote !== note) return;
    this.resumeAgain?.setAttr("style", st && st.state !== "queued" && st.state !== "checking" ? "" : "display:none");
    if (!st) return;
    note.empty();
    if (st.state === "queued" || st.state === "checking") note.setText(t("add.resumeChecking"));
    else if (st.state === "failed" || !st.checkedAt || !st.counts) note.setText(t("add.resumeFailed"));
    else {
      const date = new Date(st.checkedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      note.createSpan({ text: `${st.name} · ${t("add.resumeChecked", { date, a: st.counts.supported, b: st.counts.partly, c: st.counts.notFound })} ` });
      const link = note.createEl("a", { text: t("add.resumeResults"), cls: "cx-resume-link" });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const store = this.services.leafStore?.();
        if (store) openPage(store, "agents", { tab: "checks" });
        if (!this.onDone) this.close();
      });
    }
  }

  // ───────────── rows ─────────────

  private buildRow(parent: HTMLElement, id: string, name: string): Row {
    const root = parent.createDiv({ cls: `cx-source-row is-${id}` });
    root.setAttr("style", "display:grid;grid-template-columns:32px 1fr auto;gap:4px 12px;align-items:center;padding:8px 0;border-top:1px solid var(--background-modifier-border)");
    const tile = root.createDiv({ cls: "cx-source-tile", text: name.slice(0, 1).toUpperCase() });
    tile.setAttr("style", "width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--background-modifier-hover);font-weight:600");
    const mid = root.createDiv();
    const head = mid.createDiv();
    head.createSpan({ text: name, cls: "cx-source-name" }).setAttr("style", "font-weight:600");
    const pill = head.createSpan({ cls: "cx-pill" });
    pill.setAttr("style", "margin-left:8px;font-size:11px;color:var(--text-muted)");
    const how = mid.createDiv({ cls: "cx-source-how" });
    how.setAttr("style", "font-size:12px;color:var(--text-muted)");
    const detail = mid.createDiv({ cls: "cx-source-detail" });
    detail.setAttr("style", "font-size:12px;color:var(--text-muted)");
    const came = mid.createDiv({ cls: "cx-source-came" });
    came.setAttr("style", "font-size:12px;color:var(--text-muted)");
    const control = root.createDiv({ cls: "cx-source-control" });
    const panel = root.createDiv({ cls: "cx-source-panel" });
    panel.setAttr("style", PANEL_OFF);
    return { root, pill, detail, how, came, control, panel, open: false };
  }

  private row(id: string): Row {
    return this.rows.get(id) as Row;
  }

  /** The one-line how-to under each source's name. */
  private buildHowTos(): void {
    const fixed: Record<string, string> = { vault: t("addSources.howVault"), raw: t("addSources.howRaw"), claudeCode: t("addSources.howClaudeCode"), folder: t("addSources.howFolder") };
    for (const [id, text] of Object.entries(fixed)) this.rows.get(id)?.how.setText(text);
    for (const src of exportSources()) this.rows.get(ROW_OF_SOURCE[src.id] ?? src.id)?.how.setText(exportHowTo(src.id));
  }

  /** "Request an export": the provider's own page opens in the default browser; nothing is sent. */
  private requestButton(parent: HTMLElement, s: Pick<ExportStatus, "id" | "exportUrl">): void {
    const b = parent.createEl("button", { text: t("addSources.requestExport"), cls: "cx-request-export" });
    b.setAttr("aria-label", t("addSources.requestExportFor", { source: exportName(s.id) }));
    b.addEventListener("click", () => {
      if (openExportPage(s)) new Notice(t("addSources.requestOpened", { source: exportName(s.id) }));
    });
  }

  /** Arrival lines on the archive rows and the "Due this month" group, from the ledger's last import per source. */
  private applyArrivals(): void {
    const settings = this.settings();
    const statuses = exportStatuses([...this.rowData.values()], Date.now(), settings.sources.exportReminders.cadenceDays);
    for (const st of statuses) this.rows.get(ROW_OF_SOURCE[st.id] ?? st.id)?.came.setText(arrivalText(st));
    this.dueBox.empty();
    const due = dueThisMonth(statuses);
    if (due.length === 0) return;
    this.dueBox.createEl("strong", { text: t("addSources.dueHeading") });
    for (const st of due) {
      const line = this.dueBox.createDiv({ cls: "cx-due-row" });
      line.setAttr("style", "display:flex;gap:8px;align-items:center;font-size:12px");
      line.createSpan({ text: `${exportName(st.id)} · ${arrivalText(st)}` });
      this.requestButton(line, st);
    }
  }

  /** The extra calls "Ask per file" needs (absent when the service is a plain SourcesService). */
  private ext(): SourcesServiceExt | null {
    const s = this.services.sources as Partial<SourcesServiceExt>;
    return typeof s.listFolderFiles === "function" && typeof s.saveFolderSpeakers === "function" ? (s as SourcesServiceExt) : null;
  }

  private settings(): CortexSettings {
    return this.services.settings.value;
  }

  private update(fn: (s: CortexSettings) => void): void {
    void this.services.settings.update(fn).catch(() => new Notice(LOCAL.settingFailed));
  }

  private showPanel(r: Row, show: boolean): void {
    r.open = show;
    r.panel.setAttr("style", show ? PANEL_ON : PANEL_OFF);
    if (!show) r.panel.empty();
  }

  private toggle(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const l = parent.createEl("label");
    l.setAttr("style", "display:flex;gap:6px;align-items:center;font-size:12px");
    const input = l.createEl("input", { type: "checkbox" });
    input.checked = value;
    l.createSpan({ text: label });
    input.addEventListener("change", () => onChange(input.checked));
    return input;
  }

  private statusText(row: SourceRow | undefined): string {
    if (!row) return t("sources.statusNotAdded");
    switch (row.status) {
      case "watching":
        return t("sources.statusWatching");
      case "connected":
        return t("sources.statusConnected");
      case "importing":
        return t("sources.statusImporting");
      case "imported":
        return t("sources.statusImported", { date: row.lastImport ? row.lastImport.slice(0, 10) : "" });
      case "attention":
        return t("sources.statusAttention");
      default:
        return t("sources.statusNotAdded");
    }
  }

  private async refresh(): Promise<void> {
    let rows: SourceRow[] = [];
    try {
      rows = await this.services.sources.list();
    } catch {
      rows = [];
    }
    this.rowData = new Map(rows.map((r) => [r.id, r]));
    this.applyArrivals();
    this.applyProgress();
    const ids: [AddSourceRow, string][] = [["vault", "vault"], ["raw", "raw"], ["claudeCode", "claude-code"], ["claudeAi", "claude-ai"], ["chatgpt", "chatgpt"], ["gemini", "gemini"]];
    for (const [rowId, sourceId] of ids) {
      const data = this.rowData.get(sourceId);
      const r = this.rows.get(rowId);
      if (!r) continue;
      r.pill.setText(this.busy.has(rowId) ? t("sources.statusImporting") : this.statusText(data));
      if (data && data.storedIn && data.status !== "not-added" && rowId !== "vault" && rowId !== "raw" && rowId !== "claudeCode") r.detail.setText(t("sources.storedIn", { path: data.storedIn }));
    }
    for (const src of exportSources()) {
      const g = ROW_OF_SOURCE[src.id] ? undefined : this.rows.get(src.id);
      if (g) g.pill.setText(this.statusText(this.rowData.get(src.id)));
    }
    for (const a of AGENT_ROWS) {
      const data = this.rowData.get(a.id);
      const r = this.rows.get(a.id);
      if (!r) continue;
      r.pill.setText(this.busy.has(a.id) ? t("sources.statusImporting") : this.statusText(data));
      if (data && data.storedIn && data.status !== "not-added") r.detail.setText(t("sources.storedIn", { path: data.storedIn }));
    }
    this.row("folder").pill.setText(this.settings().sources.folders.length > 0 ? t("sources.statusConnected") : t("sources.statusNotAdded"));
    this.renderFolderList();
    // Counts come from a dry run (directories and sizes only); the rows are usable before it answers.
    try {
      const est = await this.services.sources.estimate();
      const by = (k: string) => est.sources.find((x) => x.source === k);
      const v = by("obsidian");
      if (v) this.row("vault").detail.setText(t("addSources.vaultDetail", { n: (v.items - v.reference).toLocaleString("en-GB"), m: v.reference.toLocaleString("en-GB") }));
      const raw = est.sources.find((x) => x.source === "files" && x.reference >= 0 && x.where === undefined);
      if (raw) this.row("raw").detail.setText(t("addSources.rawDetail", { n: raw.items.toLocaleString("en-GB") }));
      const cc = by("claude-code");
      if (cc) {
        this.ccWhere = cc.where ?? "";
        const last = this.rowData.get("claude-code")?.lastImport;
        this.row("claudeCode").detail.setText(`${t("addSources.claudeCodeDetail", { n: cc.items.toLocaleString("en-GB"), t: agoText(last) })}${cc.where ? ` · ${cc.where}` : ""}`);
      }
    } catch {
      // the estimate needs the runner; the rows still work without it
    }
    try {
      this.renderCcErrors(await this.services.sources.needsAttention());
    } catch {
      // no warnings to show
    }
  }

  // ───────────── vault and raw ─────────────

  private buildVault(): void {
    const r = this.row("vault");
    this.toggle(r.control, "", this.settings().sources.vault.enabled, (v) => this.update((s) => void (s.sources.vault.enabled = v)));
    r.detail.setText(t("addSources.vaultDetail", { n: "…", m: "…" }));
  }

  private buildRaw(): void {
    const r = this.row("raw");
    this.toggle(r.control, "", this.settings().sources.raw.enabled, (v) => this.update((s) => void (s.sources.raw.enabled = v)));
    r.detail.setText(t("addSources.rawDetail", { n: "…" }));
    const opts = r.panel;
    this.showPanel(r, true);
    const raw = this.settings().sources.raw;
    const refs = ".raw/roblox/creator-docs/";
    this.toggle(opts, SETTINGS_COPY.sources.rawReference, raw.referenceFolders.includes(refs), (v) =>
      this.update((s) => {
        const set = new Set(s.sources.raw.referenceFolders);
        if (v) set.add(refs);
        else set.delete(refs);
        s.sources.raw.referenceFolders = [...set];
      }),
    );
    this.toggle(opts, SETTINGS_COPY.sources.skipYaml, raw.skipYaml, (v) => this.update((s) => void (s.sources.raw.skipYaml = v)));
    this.toggle(opts, SETTINGS_COPY.sources.skipApiDump, raw.skipApiDump, (v) => this.update((s) => void (s.sources.raw.skipApiDump = v)));
  }

  // ───────────── Claude Code ─────────────

  private buildClaudeCode(): void {
    const r = this.row("claudeCode");
    const cc = this.settings().sources.claudeCode;
    r.detail.setText(t("addSources.claudeCodeDetail", { n: "…", t: "–" }));
    const extra = r.root.createDiv({ cls: "cx-cc-extra" });
    extra.setAttr("style", "grid-column:2 / span 2;display:flex;flex-direction:column;gap:4px");
    const wrap = extra.createDiv({ cls: "cx-cc-progress" });
    wrap.setAttr("style", "display:none");
    const text = wrap.createDiv({ cls: "cx-modal-subtitle" });
    const bar = wrap.createEl("progress") as HTMLProgressElement;
    bar.setAttr("style", "width:100%");
    this.ccProgress = { wrap, text, bar };
    this.ccErrors = extra.createDiv({ cls: "cx-cc-errors" });
    const btn = r.control.createEl("button", { text: t("addSources.options") });
    btn.addEventListener("click", () => {
      const open = !r.open;
      this.showPanel(r, open);
      if (open) this.fillClaudeCodePanel(r);
    });
    void cc;
  }

  /** "Reading ‹n› sessions… ‹k› of ‹n› · ‹m› messages kept" with a bar, or nothing when no import runs. */
  private showCcProgress(p: { done: number; total?: number; kept?: number } | null): void {
    const c = this.ccProgress;
    if (!c) return;
    if (!p) {
      c.wrap.setAttr("style", "display:none");
      return;
    }
    const total = p.total ?? p.done;
    c.wrap.setAttr("style", "display:block");
    c.text.setText(t("addSources.claudeCodeReading", { n: total.toLocaleString("en-US"), k: p.done.toLocaleString("en-US"), m: (p.kept ?? 0).toLocaleString("en-US") }));
    c.bar.max = Math.max(1, total);
    c.bar.value = Math.min(p.done, c.bar.max);
  }

  /** Show the progress while Claude Code is the source being imported; hide it otherwise. */
  private applyProgress(): void {
    const ours = this.busy.has("claudeCode") || this.rowData.get("claude-code")?.status === "importing";
    if (this.importing !== undefined && ours) this.showCcProgress(this.importing);
    // An import run from this modal reports through its own callback and hides the bar when it ends.
    else if (!this.busy.has("claudeCode")) this.showCcProgress(null);
  }

  private onActivity(importing: { done: number; total?: number; kept?: number } | undefined): void {
    this.importing = importing;
    const running = importing !== undefined;
    this.applyProgress();
    if (running !== this.wasImporting) {
      this.wasImporting = running;
      void this.refresh();
    }
  }

  /** Read errors on the Claude Code row: an unreadable folder, files that aren't session logs; Show details lists where. */
  private renderCcErrors(rows: readonly { code: string; count: number; detail?: string }[]): void {
    const box = this.ccErrors;
    if (!box) return;
    box.empty();
    const lines: string[] = [];
    const details: string[] = [];
    for (const a of rows) {
      if (a.code === "path-unreadable") {
        const path = a.detail ?? this.ccWhere;
        lines.push(t("addSources.cantRead", { path }));
        details.push(path);
      } else if (a.code === "skipped-not-session") {
        lines.push(t("addSources.skippedFiles", { n: a.count.toLocaleString("en-US") }));
        details.push(this.ccWhere || this.settings().sources.claudeCode.projectsDir);
      }
    }
    if (lines.length === 0) return;
    for (const l of lines) box.createDiv({ text: l, cls: "cx-modal-subtitle" });
    const more = box.createEl("button", { text: t("sources.showDetails"), cls: "cx-text-button" });
    const body = box.createDiv({ cls: "cx-modal-subtitle" });
    body.setAttr("style", "display:none");
    for (const d of details.filter((x) => x.length > 0)) body.createDiv({ text: d });
    let shown = false;
    more.addEventListener("click", () => {
      shown = !shown;
      body.setAttr("style", shown ? "display:block" : "display:none");
    });
  }

  private fillClaudeCodePanel(r: Row): void {
    const p = r.panel;
    const cc = this.settings().sources.claudeCode;
    this.toggle(p, SETTINGS_COPY.sources.watch, cc.watch, (v) => this.update((s) => void (s.sources.claudeCode.watch = v)));
    this.toggle(p, SETTINGS_COPY.sources.subagents, cc.includeSubagents, (v) => this.update((s) => void (s.sources.claudeCode.includeSubagents = v)));
    this.toggle(p, SETTINGS_COPY.sources.toolOutput, cc.includeToolOutput, (v) => this.update((s) => void (s.sources.claudeCode.includeToolOutput = v)));
    this.toggle(p, SETTINGS_COPY.sources.thinking, cc.includeThinking, (v) => this.update((s) => void (s.sources.claudeCode.includeThinking = v)));
    const table = p.createDiv();
    table.setAttr("style", "display:grid;grid-template-columns:1fr auto;gap:4px 12px;font-size:12px");
    for (const [slug, space] of Object.entries(cc.spaceMap)) {
      table.createSpan({ text: slug });
      const sel = table.createEl("select");
      for (const o of [...SPACES.map((s) => [s.id, s.name] as const), ["none", "No area"] as const]) sel.createEl("option", { text: o[1], value: o[0] });
      sel.value = space;
      sel.addEventListener("change", () => this.update((s) => void (s.sources.claudeCode.spaceMap[slug] = sel.value as SpaceId)));
    }
    p.createEl("p", { text: t("addSources.retention"), cls: "cx-modal-subtitle" });
    const go = p.createEl("button", { text: t("sources.importAgain") });
    const msg = p.createDiv({ cls: "cx-modal-subtitle" });
    go.addEventListener("click", () => void this.runImport("claudeCode", { kind: "claude-code" }, msg, LOCAL.importedFiles));
  }

  // ───────────── other coding agents ─────────────

  /** Off until chosen: a switch to read the sessions, a switch to keep watching, and Read now. */
  private buildAgents(): void {
    for (const a of AGENT_ROWS) {
      const r = this.row(a.id);
      r.how.setText(t(a.how));
      r.control.setAttr("style", "display:flex;flex-direction:column;gap:4px;align-items:flex-start");
      const cfg = this.settings().sources[a.key];
      this.toggle(r.control, t("addSources.agentRead"), cfg.enabled, (v) => this.update((s) => void (s.sources[a.key].enabled = v)));
      this.toggle(r.control, t("addSources.agentWatch"), cfg.watch, (v) => this.update((s) => void (s.sources[a.key].watch = v)));
      const go = r.control.createEl("button", { text: t("addSources.agentReadNow") });
      go.addEventListener("click", () => {
        this.showPanel(r, true);
        const msg = r.panel.createDiv({ cls: "cx-modal-subtitle" });
        // Reading is opt-in: the switch above is turned on first, then the pass runs.
        void this.services.settings
          .update((s) => void (s.sources[a.key].enabled = true))
          .then(() => this.runImport(a.id, { kind: a.id } as SourceSelector, msg, t("addSources.agentDone")))
          .catch(() => msg.setText(LOCAL.couldntImport));
      });
    }
  }

  // ───────────── exports ─────────────

  private buildExport(id: ExportRow): void {
    const r = this.row(id);
    const label = id === "gemini" ? t("addSources.choose") : t("addSources.import");
    const btn = r.control.createEl("button", { text: label });
    btn.addEventListener("click", () => void this.pick(r.panel, "zip-or-folder", (p) => void this.inspectInto(id, p)));
    const src = exportSources().find((x) => x.id === EXPORT_ROWS[id]);
    if (src) this.requestButton(r.control, src);
    void this.services.sources.list().then((rows) => {
      if (rows.find((x) => x.id === EXPORT_ROWS[id])?.status === "imported" && id !== "gemini") btn.setText(t("addSources.importNewer"));
    });
  }

  /** A row for an archive source an importer package added: Choose… finds out whether the file is its export. */
  private buildGenericExport(src: ExportSource): void {
    const r = this.row(src.id);
    r.control.createEl("button", { text: t("addSources.choose") }).addEventListener("click", () => void this.pick(r.panel, "zip-or-folder", (p) => void this.inspectGeneric(src, p)));
    this.requestButton(r.control, src);
  }

  private async inspectGeneric(src: ExportSource, file: string, known?: InspectResult): Promise<void> {
    const r = this.row(src.id);
    this.showPanel(r, true);
    r.panel.setText(t("addSources.checking"));
    try {
      const res = known ?? (await this.services.sources.inspect(file));
      r.panel.empty();
      if ((res.kind as string) !== src.id || res.conversations === 0) {
        r.panel.createDiv({ text: LOCAL.unknown });
        return;
      }
      r.panel.createDiv({ text: t("addSources.genericPreview", { n: res.conversations.toLocaleString("en-US") }) });
      const msg = r.panel.createDiv({ cls: "cx-modal-subtitle" });
      const go = r.panel.createEl("button", { text: t("addSources.importButton"), cls: "mod-cta" });
      go.addEventListener("click", () => {
        go.disabled = true;
        void this.runImport(src.id, { kind: src.id, file } as unknown as SourceSelector, msg, LOCAL.importedFiles, { n: res.conversations });
      });
    } catch {
      r.panel.setText(LOCAL.couldntImport);
    }
  }

  /** Dialog first; when this Obsidian has none, a typed-path field in the panel. */
  private async pick(into: HTMLElement, kind: PickKind, done: (p: string) => void): Promise<void> {
    let chosen: string | null = null;
    try {
      chosen = await showOpenDialog(kind);
    } catch {
      chosen = null;
    }
    if (chosen) done(chosen);
    else this.askForPath(into, kind, done);
  }

  private askForPath(into: HTMLElement, kind: PickKind, done: (p: string) => void): void {
    void kind;
    if (into === this.zoneNote) into.empty();
    else {
      into.setAttr("style", PANEL_ON);
      into.empty();
    }
    const input = into.createEl("input", { type: "text", placeholder: `${t("addSources.typePath")} · ${LOCAL.typePathHint}` });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (isAbsoluteTypedPath(input.value)) done(input.value.trim());
      else input.addClass("mod-error");
    });
    (input as { focus?: () => void }).focus?.();
  }

  /** The drop zone: find out which service an export came from, then continue in that service's row. */
  private async route(file: string): Promise<void> {
    this.zoneNote.setText(t("addSources.checking"));
    try {
      const res = await this.services.sources.inspect(file);
      const row = (Object.keys(EXPORT_ROWS) as ExportRow[]).find((k) => EXPORT_ROWS[k] === res.kind);
      const generic = this.genericRowFor(res);
      if (!row && generic) {
        this.zoneNote.setText("");
        void this.inspectGeneric(generic, file, res);
        return;
      }
      if (!row) {
        this.zoneNote.setText(res.problem === "takeout-html" ? t("addSources.takeoutHtml") : LOCAL.unknown);
        return;
      }
      this.zoneNote.setText("");
      this.showPreview(row, file, res);
    } catch {
      this.zoneNote.setText(LOCAL.unknown);
    }
  }

  /** Open folder: an unzipped export is recognised and previewed; any other folder goes to "A folder of your own". */
  private async routeFolder(dir: string): Promise<void> {
    this.zoneNote.setText(t("addSources.checking"));
    try {
      const res = await this.services.sources.inspect(dir);
      const row = (Object.keys(EXPORT_ROWS) as ExportRow[]).find((k) => EXPORT_ROWS[k] === res.kind);
      if (row) {
        this.zoneNote.setText("");
        this.showPreview(row, dir, res);
        return;
      }
      const generic = this.genericRowFor(res);
      if (generic) {
        this.zoneNote.setText("");
        void this.inspectGeneric(generic, dir, res);
        return;
      }
    } catch {
      // not an export: treat it as a folder of the person's own files
    }
    this.zoneNote.setText("");
    this.folderOptions(dir);
    (this.row("folder").root as { scrollIntoView?: (o: object) => void }).scrollIntoView?.({ block: "nearest" });
  }

  /** The row of an archive source an importer package added (Notion, Google Docs …) that this inspected export belongs to. */
  private genericRowFor(res: InspectResult): ExportSource | undefined {
    return res.conversations > 0 ? exportSources().find((x) => x.id === (res.kind as string) && !ROW_OF_SOURCE[x.id]) : undefined;
  }

  private async inspectInto(id: ExportRow, file: string): Promise<void> {
    const r = this.row(id);
    this.showPanel(r, true);
    r.panel.setText(t("addSources.checking"));
    try {
      const res = await this.services.sources.inspect(file);
      this.showPreview(id, file, res);
    } catch {
      r.panel.setText(LOCAL.couldntImport);
    }
  }

  private problemText(id: ExportRow, res: InspectResult): string | null {
    if (res.problem === "takeout-html") return t("addSources.takeoutHtml");
    if (res.problem === "export-empty") return id === "gemini" ? t("addSources.noGemini") : id === "chatgpt" ? t("addSources.notChatgpt") : t("addSources.notClaude");
    if (res.problem === "export-not-recognised" || res.kind !== EXPORT_ROWS[id]) return id === "gemini" ? t("addSources.noGemini") : id === "chatgpt" ? t("addSources.notChatgpt") : t("addSources.notClaude");
    return null;
  }

  private showPreview(id: ExportRow, file: string, res: InspectResult): void {
    const r = this.row(id);
    this.showPanel(r, true);
    r.panel.empty();
    const problem = this.problemText(id, res);
    if (problem) {
      r.panel.createDiv({ text: problem });
      return;
    }
    const range = res.range ? `${res.range[0].slice(0, 7)} – ${res.range[1].slice(0, 7)}` : "";
    if (id === "gemini") {
      r.panel.createDiv({ text: t("addSources.geminiPreview", { n: (res.exchanges ?? res.conversations).toLocaleString("en-US"), m: res.conversations.toLocaleString("en-US") }) });
      if (range) r.panel.createDiv({ text: range, cls: "cx-modal-subtitle" });
      r.panel.createDiv({ text: t("addSources.geminiGrouping"), cls: "cx-modal-subtitle" });
    } else {
      r.panel.createDiv({ text: t("addSources.preview", { n: res.conversations, range, projects: res.projects, attachments: res.attachments }) });
      if (id === "chatgpt") r.panel.createDiv({ text: t("addSources.branches"), cls: "cx-modal-subtitle" });
      if (id === "claudeAi") {
        this.toggle(r.panel, t("addSources.attachmentsText"), this.settings().sources.claudeAi.includeAttachments, (v) => this.update((s) => void (s.sources.claudeAi.includeAttachments = v)));
      }
    }
    const msg = r.panel.createDiv({ cls: "cx-modal-subtitle" });
    const selector = { kind: EXPORT_ROWS[id], file } as SourceSelector;
    const older = res.olderThanImportedAt !== undefined;
    if (older) msg.setText(t("addSources.older", { date: (res.olderThanImportedAt as string).slice(0, 10) }));
    else if (res.truncated) msg.setText(t("warnings.export-truncated"));
    const go = r.panel.createEl("button", { text: older ? t("addSources.importAnyway") : t("addSources.importButton"), cls: "mod-cta" });
    go.addEventListener("click", () => {
      go.disabled = true;
      void this.runImport(id, selector, msg, LOCAL.imported, { n: Math.max(0, res.conversations - res.alreadyImported), skipped: res.alreadyImported });
    });
  }

  private async runImport(rowId: string, selector: SourceSelector, msg: HTMLElement, done: string, values: Record<string, number> = {}): Promise<void> {
    this.busy.add(rowId);
    msg.setText(LOCAL.importing);
    void this.refresh();
    try {
      await this.services.sources.importNow(selector, rowId === "claudeCode" ? (p) => this.showCcProgress(p) : undefined);
      if (rowId === "claudeCode") this.showCcProgress(null);
      msg.setText(done.replace(/\{(\w+)\}/g, (_m, k: string) => String(values[k] ?? "")));
    } catch (e) {
      msg.setText(e instanceof CortexError && e.code === "E_BAD_REQUEST" && this.services.sandbox.value ? LOCAL.notSample : LOCAL.couldntImport);
    } finally {
      this.busy.delete(rowId);
      void this.refresh();
    }
  }

  // ───────────── folders ─────────────

  private buildFolder(): void {
    const r = this.row("folder");
    r.detail.setText("");
    const btn = r.control.createEl("button", { text: t("addSources.chooseFolder") });
    btn.addEventListener("click", () => void this.pick(r.panel, "folder", (p) => this.folderOptions(p)));
  }

  private renderFolderList(): void {
    const r = this.row("folder");
    const folders = this.settings().sources.folders;
    r.detail.empty();
    for (const f of folders) {
      const line = r.detail.createDiv();
      line.setAttr("style", "display:flex;gap:8px;align-items:center");
      const data = this.rowData.get(`folder:${f.id}`);
      line.createSpan({ text: `${f.label} · ${t("addSources.folderDetail", { n: data?.items ?? 0 })}${f.watch ? "" : ""}` });
      const b = line.createEl("button", { text: f.watch ? t("addSources.pause") : t("addSources.resume") });
      b.addEventListener("click", () => {
        void this.services.sources.pauseWatching(`folder:${f.id}`, f.watch).then(() => this.refresh());
      });
    }
  }

  private folderOptions(dir: string): void {
    const r = this.row("folder");
    this.showPanel(r, true);
    r.panel.empty();
    r.panel.createDiv({ text: dir, cls: "cx-modal-subtitle" });
    r.panel.createEl("strong", { text: t("addSources.whose") });
    let who: SpeakerChoice = "you";
    const group = r.panel.createDiv();
    group.setAttr("style", "display:flex;gap:12px");
    const choices: [SpeakerChoice, string][] = [["you", t("addSources.mine")], ["other", t("addSources.anotherPerson")]];
    if (this.ext()) choices.push(["ask", t("addSources.askPerFile")]);
    for (const [value, label] of choices) {
      const l = group.createEl("label");
      const input = l.createEl("input", { type: "radio" });
      input.name = "cx-whose";
      input.checked = value === who;
      input.addEventListener("change", () => (who = value));
      l.createSpan({ text: ` ${label}` });
    }
    r.panel.createEl("strong", { text: t("addSources.fileTypes") });
    const types = new Set<string>(["md", "txt"]);
    const typeRow = r.panel.createDiv();
    typeRow.setAttr("style", "display:flex;gap:12px;flex-wrap:wrap");
    for (const ft of FILE_TYPES) {
      this.toggle(typeRow, ft, types.has(ft), (v) => (v ? types.add(ft) : types.delete(ft)));
    }
    let watch = true;
    this.toggle(r.panel, t("addSources.watch"), watch, (v) => (watch = v));
    const msg = r.panel.createDiv({ cls: "cx-modal-subtitle" });
    const go = r.panel.createEl("button", { text: t("addSources.importButton"), cls: "mod-cta" });
    go.addEventListener("click", () => {
      if (types.size === 0) return;
      const folder: FolderSourceSetting = { id: newFolderId(), path: dir, label: folderLabel(dir), extensions: extensionsOfTypes([...types]), space: "none", watch, enabled: true };
      go.disabled = true;
      void this.addFolder(folder, who, msg);
    });
  }

  private async addFolder(folder: FolderSourceSetting, who: SpeakerChoice, msg: HTMLElement): Promise<void> {
    const key = `folder:${folder.id}`;
    if (who === "ask") {
      msg.setText(LOCAL.importing);
      const files = (await this.ext()?.listFolderFiles(folder.path, folder.extensions)) ?? [];
      if (files.length === 0) {
        msg.setText(LOCAL.noFiles);
        return;
      }
      this.askPerFile(folder, files);
      return;
    }
    await this.services.settings.update((s) => {
      s.sources.folders.push(folder);
      s.you.speakerBySource[key] = who;
    });
    await this.runImport("folder", { kind: "folder", id: folder.id }, msg, LOCAL.importedFiles);
  }

  /** "Ask per file": one answer for each file; files left out are not imported. */
  private askPerFile(folder: FolderSourceSetting, files: string[]): void {
    const r = this.row("folder");
    r.panel.empty();
    r.panel.createEl("strong", { text: t("addSources.whose") });
    const answers = new Map<string, "you" | "other">();
    const selects: HTMLSelectElement[] = [];
    const bulk = r.panel.createDiv();
    const setAll = (v: "you" | "other"): void => selects.forEach((s) => ((s.value = v), s.dispatchEvent(new Event("change"))));
    bulk.createEl("button", { text: LOCAL.allMine }).addEventListener("click", () => setAll("you"));
    bulk.createEl("button", { text: LOCAL.allAnother }).addEventListener("click", () => setAll("other"));
    const list = r.panel.createDiv();
    list.setAttr("style", "max-height:220px;overflow:auto;display:grid;grid-template-columns:1fr auto;gap:2px 12px;font-size:12px");
    for (const f of files) {
      list.createSpan({ text: f });
      const sel = list.createEl("select");
      sel.createEl("option", { text: LOCAL.skipFile, value: "" });
      sel.createEl("option", { text: t("addSources.mine"), value: "you" });
      sel.createEl("option", { text: t("addSources.anotherPerson"), value: "other" });
      sel.addEventListener("change", () => (sel.value === "you" || sel.value === "other" ? answers.set(f, sel.value) : answers.delete(f)));
      selects.push(sel);
    }
    const msg = r.panel.createDiv({ cls: "cx-modal-subtitle" });
    const go = r.panel.createEl("button", { text: t("addSources.importButton"), cls: "mod-cta" });
    go.addEventListener("click", () => {
      go.disabled = true;
      void (async () => {
        await this.ext()?.saveFolderSpeakers(folder.id, Object.fromEntries(answers));
        await this.services.settings.update((s) => {
          s.sources.folders.push(folder);
          s.you.speakerBySource[`folder:${folder.id}`] = "ask";
        });
        await this.runImport("folder", { kind: "folder", id: folder.id }, msg, LOCAL.importedFiles);
      })();
    });
  }
}
