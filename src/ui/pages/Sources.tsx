/**
 * Sources (CORTEX-UX §5.22): header "Sources", button Add sources, More; segmented Sources · Files (P2) ·
 * Privacy; subtitle "Everything Cortex reads, where it's kept, and how fresh it is." Owner: E12, data from
 * SourcesService (E3) and CorrectionService (left out).
 *  - Sources: one row per source — status pill, counts, a "your words" column (mono share + speaker-split bar),
 *    last import, "Stored in ‹folder› · not tracked by git", menu Pause watching · Import again · Remove source…
 *    (§5.30.4) · Reveal folder; then Needs attention rows by warning code (§5.31), never raw error text.
 *  - Files: imported documents and attachments by folder (name, size, versions, Unchanged since import / Changed
 *    on disk · import the new version?, Export file… when a copy is kept).
 *  - Privacy: the Off limits table (fixed never-read rows + your folders), sources and conversations you left out
 *    with Bring back, what each source sends to models, and a Names and handles link to Settings › Privacy.
 * Empty: "No sources yet. Add your vault notes and Claude Code sessions to start."
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { AttentionRow, FileRow, SourceRow } from "../../plugin/services";
import { dueThisMonth, exportSourceOf, exportStatuses, type ExportStatus } from "../../shared/exportDue";
import { featureOn } from "../../shared/features";
import type { SourceSelector } from "../../shared/protocol/runner";
import { useLeaf, useServices } from "../context";
import { SETTINGS_COPY, t, type CopyKey } from "../copy";
import { arrivalText, exportName, openExportPage } from "../exportText";
import { confirm } from "../modals/ConfirmModal";
import { Button, Icon, StatusPill } from "../primitives/buttons";
import { SourceIcon, SplitBar } from "../reader/marks";
import { fmtBytes, fmtInt, isoMs, sourceLabel } from "../valueLabels";
import { ScreenedList } from "./agents/ScreenedList";
import { CapturePanel } from "./sources/CapturePanel";
import { WorkerBanner } from "./WorkerBanner";
import { ChangeSlot, Load, openCortexSettings, openMenuAt, PageFrame, PageTabs, runObsidianCommand, setPageParams, useChange, useFmt, useLoad } from "./PageFrame";

/** The fixed never-read rows of the Off limits table (§5.22). */
export const NEVER_READ = ["sources.browsers", "sources.mail", "sources.keys", "sources.git"] as const;

/** Status pill copy key for a source row. */
export function statusKey(s: SourceRow["status"]): "sources.statusConnected" | "sources.statusWatching" | "sources.statusImporting" | "sources.statusImported" | "sources.statusNotAdded" | "sources.statusAttention" {
  switch (s) {
    case "connected":
      return "sources.statusConnected";
    case "watching":
      return "sources.statusWatching";
    case "importing":
      return "sources.statusImporting";
    case "imported":
      return "sources.statusImported";
    case "not-added":
      return "sources.statusNotAdded";
    default:
      return "sources.statusAttention";
  }
}

const STATUS_TONE: Readonly<Record<SourceRow["status"], "ok" | "warn" | "serious" | "critical" | "accent" | "muted">> = {
  connected: "ok",
  watching: "ok",
  importing: "accent",
  imported: "muted",
  "not-added": "muted",
  attention: "warn",
};

/** The importer selector for "Import again", or null when the source needs its export picked again (Add sources). */
export function selectorFor(row: Pick<SourceRow, "id" | "kind">): SourceSelector | null {
  switch (row.kind) {
    case "claude-code":
      return { kind: "claude-code" };
    case "codex-cli":
    case "gemini-cli":
    case "cursor":
    case "capture":
      return { kind: row.kind };
    case "obsidian":
    case "files":
      return row.id.startsWith("folder") || row.id.startsWith("f_") ? { kind: "folder", id: row.id } : { kind: "raw" };
    default:
      return null;
  }
}

/** The line a source row shows for its status ("Imported 4 Nov 2026" carries the date). */
export function statusText(row: SourceRow, date: (ms: number) => string): string {
  const key = statusKey(row.status);
  return key === "sources.statusImported" ? t(key, { date: row.lastImport ? date(isoMs(row.lastImport)) : t("sources.never") }) : t(key);
}

export function Sources(p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const filesOn = featureOn("sourcesFiles");
  const tab = p.params.tab === "files" && filesOn ? "files" : p.params.tab === "privacy" ? "privacy" : "sources";
  return (
    <PageFrame
      subtitle={t(tab === "files" ? "sources.subtitleFiles" : tab === "privacy" ? "sources.subtitlePrivacy" : "sources.subtitle")}
      actions={
        <Button icon="addSources" onClick={() => runObsidianCommand(s.app, "cortex:add-sources")}>
          {t("sources.addSources")}
        </Button>
      }
      tabs={
        <PageTabs
          label={t("pages.sources")}
          value={tab}
          options={[
            { value: "sources", label: t("sources.tabSources") },
            ...(filesOn ? [{ value: "files" as const, label: t("sources.tabFiles") }] : []),
            { value: "privacy", label: t("sources.tabPrivacy") },
          ]}
          onChange={(v) => setPageParams(leaf.store, { tab: v === "sources" ? null : v })}
        />
      }
    >
      <WorkerBanner />
      <section class={`cx-sources is-${tab}`}>{tab === "files" ? <Files /> : tab === "privacy" ? <Privacy /> : <SourceList />}</section>
    </PageFrame>
  );
}

// ───────────────────────────── Sources ─────────────────────────────

function SourceList(): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const change = useChange();
  const data = s.shared.slices.data.value;
  const rows = useLoad(() => s.sources.list(), [data.seq, data.phase]);
  const attention = useLoad(() => s.sources.needsAttention(), [data.seq, data.phase]);
  const [nonce, setNonce] = useState(0);
  const fail = () => change.post(t("errors.action"));

  const menu = (e: Event, row: SourceRow) => {
    const sel = selectorFor(row);
    openMenuAt(
      e,
      [
        { value: "pause", label: row.watching ? t("sources.pauseWatching") : t("sources.resumeWatching"), group: "a" },
        { value: "import", label: t("sources.importAgain"), group: "a" },
        { value: "reveal", label: t("sources.reveal"), group: "a" },
        { value: "remove", label: t("sources.remove"), group: "b", warning: true },
      ],
      (v) => {
        if (v === "pause") void s.sources.pauseWatching(row.id, row.watching).then(() => setNonce(nonce + 1), fail);
        else if (v === "import") {
          if (sel) void s.sources.importNow(sel).then(() => change.post(t("sources.importStarted")), fail);
          else runObsidianCommand(s.app, "cortex:add-sources");
        } else if (v === "reveal") s.sources.reveal(row.id);
        else
          void confirm(s.app, { title: t("dialogs.removeTitle", { source: sourceLabel(row.kind) }), body: t("dialogs.removeBody"), confirm: t("dialogs.removeButton"), cancel: t("dialogs.cancel"), warning: true }).then((ok) => {
            if (ok) void s.sources.remove(row.id).then(() => (change.post(t("sources.removed", { source: sourceLabel(row.kind) })), setNonce(nonce + 1)), fail);
          });
      },
    );
  };

  const request = (st: Pick<ExportStatus, "id" | "exportUrl">) => {
    if (openExportPage(st)) change.post(t("addSources.requestOpened", { source: exportName(st.id) }));
  };
  const requestButton = (st: Pick<ExportStatus, "id" | "exportUrl">) => (
    <Button class="cx-request-export" title={t("addSources.requestExportFor", { source: exportName(st.id) })} onClick={() => request(st)}>
      {t("addSources.requestExport")}
    </Button>
  );

  return (
    <>
      <Load value={rows} failed={t("errors.sources")} rows={5}>
        {(list) => {
          const statuses = exportStatuses(list, Date.now(), s.settings.value.sources.exportReminders.cadenceDays);
          const byId = new Map(statuses.map((x) => [x.id, x]));
          const due = dueThisMonth(statuses);
          return list.length === 0 ? (
            <p class="cx-note">{t("sources.empty")}</p>
          ) : (
            <>
              {due.length > 0 ? (
                <section class="cx-due-group" aria-label={t("sources.dueThisMonth")}>
                  <h3>{t("sources.dueThisMonth")}</h3>
                  <p class="cx-note">{t("sources.dueNote")}</p>
                  <ul class="cx-source-rows">
                    {due.map((st) => (
                      <li class="cx-source-row cx-due-row">
                        <div class="cx-source-main">
                          <strong>{exportName(st.id)}</strong>
                          <span class="cx-note cx-mono">{arrivalText(st)}</span>
                          {requestButton(st)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <ul class="cx-source-rows" data-nonce={nonce}>
                {list.map((r) => (
                  <li class="cx-source-row">
                    <div class="cx-source-main">
                      <SourceIcon source={r.kind} label />
                      <StatusPill state={STATUS_TONE[r.status]}>{statusText(r, (ms) => fmt.date(ms, true))}</StatusPill>
                      <button type="button" class="cx-icon-button" aria-label={t("sources.actions")} aria-haspopup="menu" onClick={(e) => menu(e, r)}>
                        <Icon name="more" />
                      </button>
                    </div>
                    <dl class="cx-source-facts">
                      <dt>{t("sources.entries")}</dt>
                      <dd class="cx-mono">{fmtInt(r.items)}</dd>
                      <dt>{t("sources.yourWords")}</dt>
                      <dd class="cx-mono">
                        {Math.round(r.yourShare * 100)}% <SplitBar share={r.yourShare} />
                      </dd>
                      <dt>{t("sources.lastImport")}</dt>
                      <dd class="cx-mono">{r.lastImport ? fmt.rel(isoMs(r.lastImport)) : t("sources.never")}</dd>
                    </dl>
                    <p class="cx-note cx-mono">{t("sources.storedIn", { path: r.storedIn })}</p>
                    {exportSourceOf(r.id) && byId.get(r.id) ? (
                      <div class="cx-source-came">
                        <span class="cx-note cx-mono">{arrivalText(byId.get(r.id) as ExportStatus)}</span>
                        {requestButton(byId.get(r.id) as ExportStatus)}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          );
        }}
      </Load>
      <Load value={attention} failed={t("errors.sources")} rows={2}>
        {(list) => (list.length === 0 ? null : <Attention rows={list} onDone={() => setNonce(nonce + 1)} />)}
      </Load>
      <CapturePanel />
      <ChangeSlot state={change} />
    </>
  );
}

/** The sentence for an attention row, from the catalogue (never raw error text). */
export function attentionText(a: Pick<AttentionRow, "code" | "count" | "detail">): string {
  switch (a.code) {
    case "onedrive-conflict-copy":
      return t("sources.conflictCopy", { file: a.detail ?? "" });
    case "not-local":
      return t("sources.notLocalFiles", { n: a.count.toLocaleString("en-GB") });
    case "path-unreadable":
      return t("sources.pathUnreadable");
    case "skipped-not-session":
      return t("sources.skipped", { n: a.count.toLocaleString("en-GB") });
    case "secret-held":
      return t("sources.secretsHeld", { n: a.count.toLocaleString("en-GB") });
    case "index-failed":
      return t(a.detail === "none" ? "banners.indexFailedNone" : "banners.indexFailed");
    case "runner-unavailable":
    case "node-missing":
    case "settings-unreadable":
    case "changed-at-source":
    case "export-not-recognised":
    case "export-older":
    case "export-empty":
    case "takeout-html":
    case "export-truncated":
    case "injection-signal":
    case "cli-flag-rejected":
      return t(`warnings.${a.code}` as CopyKey, { n: a.count.toLocaleString("en-GB") });
    default:
      return t("sources.failedConversations", { n: a.count.toLocaleString("en-GB") });
  }
}

function Attention(p: { rows: readonly AttentionRow[]; onDone(): void }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const act = (a: AttentionRow) => {
    switch (a.action) {
      case "fetch-now":
        void s.sources.fetchNow().then(p.onDone);
        break;
      case "show":
      case "show-details":
        setPageParams(leaf.store, { tab: "files" });
        break;
      case "export-diagnostics":
        openCortexSettings(s.app, "advanced");
        break;
      case "rebuild-index":
        openCortexSettings(s.app, "advanced");
        break;
      default:
        break;
    }
  };
  const actionText = (a: AttentionRow): string | null => (a.action === "fetch-now" ? t("sources.fetchNow") : a.action === "show" ? t("sources.show") : a.action === "show-details" ? t("sources.showDetails") : a.action === "export-diagnostics" ? SETTINGS_COPY.advanced.diagnostics : a.action === "rebuild-index" ? SETTINGS_COPY.advanced.rebuild : null);
  return (
    <section class="cx-attention" aria-label={t("sources.needsAttention")}>
      <div class="cx-section-label">
        <span>{t("sources.needsAttention")}</span>
      </div>
      <ul>
        {p.rows.map((a) => {
          const label = actionText(a);
          return (
            <li class="cx-attention-row">
              <Icon name="warning" />
              <span>{attentionText(a)}</span>
              {label ? (
                <button type="button" class="cx-text-button" onClick={() => act(a)}>
                  {label}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ───────────────────────────── Files ─────────────────────────────

function Files(): JSX.Element {
  const s = useServices();
  const change = useChange();
  const files = useLoad(() => s.sources.files(), []);
  const exportFile = (f: FileRow) => void s.sources.exportFile(f.path).then(undefined, () => change.post(t("errors.action")));
  return (
    <Load value={files} failed={t("errors.files")} rows={5}>
      {(list) =>
        list.length === 0 ? (
          <p class="cx-note">{t("sources.noFiles")}</p>
        ) : (
          <>
            <table class="cx-table">
              <thead>
                <tr>
                  <th scope="col">{t("sources.name")}</th>
                  <th scope="col">{t("sources.size")}</th>
                  <th scope="col">{t("sources.versions")}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr>
                    <th scope="row" title={f.path}>
                      {f.name}
                    </th>
                    <td class="cx-mono">{fmtBytes(f.bytes)}</td>
                    <td class="cx-mono">{f.versions}</td>
                    <td>
                      <span class="cx-note">{f.state === "changed" ? t("sources.changed") : t("sources.unchanged")}</span>
                      {f.exportable ? (
                        <button type="button" class="cx-text-button" onClick={() => exportFile(f)}>
                          {t("sources.exportFile")}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ChangeSlot state={change} />
          </>
        )
      }
    </Load>
  );
}

// ───────────────────────────── Privacy ─────────────────────────────

const SENT_KEYS = ["sources.sentClaudeCode", "sources.sentClaudeAi", "sources.sentChatgpt", "sources.sentGemini", "sources.sentVault", "sources.sentRaw", "sources.sentFolders", "sources.sentWritten"] as const;

function scopeText(scope: string): string {
  return scope === "entry" ? t("sources.scopeEntry") : scope === "conversation" ? t("sources.scopeConversation") : scope === "source" ? t("sources.scopeSource") : scope === "folder" ? t("sources.scopeFolder") : t("sources.scopeProject");
}

function Privacy(): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const change = useChange();
  const [nonce, setNonce] = useState(0);
  const offLimits = s.settings.value.privacy.offLimits;
  const left = s.corrections.leftOut();
  const bringBack = (id: string) =>
    void s.corrections.include(id as Parameters<typeof s.corrections.include>[0], "sources").then(
      (rec) => {
        change.post(t("sources.bringBack"), async () => void (await s.corrections.undo(rec.id, "sources")));
        setNonce(nonce + 1);
      },
      () => change.post(t("errors.action")),
    );
  return (
    <div class="cx-privacy" data-nonce={nonce}>
      <section aria-label={t("sources.offLimits")}>
        <div class="cx-section-label">
          <span>{t("sources.offLimits")}</span>
        </div>
        <table class="cx-table">
          <thead>
            <tr>
              <th scope="col">{t("sources.pathOrApp")}</th>
              <th scope="col">{t("sources.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {NEVER_READ.map((k) => (
              <tr>
                <th scope="row">{t(k)}</th>
                <td class="cx-note">
                  <Icon name="lock" />
                </td>
              </tr>
            ))}
            {offLimits.map((r) => (
              <tr>
                <th scope="row" class="cx-mono">
                  {r.path}
                </th>
                <td class="cx-note">{r.reason || t("sources.yourChoice")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-label={t("sources.leftOut")}>
        <div class="cx-section-label">
          <span>{t("sources.leftOut")}</span>
        </div>
        {left.length === 0 ? (
          <p class="cx-note">{t("sources.leftOutEmpty")}</p>
        ) : (
          <ul class="cx-left-out">
            {left.map((l) => (
              <li>
                <span>{t("sources.leftOutRow", { scope: scopeText(l.scope), date: fmt.date(isoMs(l.at), true) })}</span>
                <button type="button" class="cx-text-button" onClick={() => bringBack(l.correctionId)}>
                  {t("sources.bringBack")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ScreenedList />
      <section aria-label={t("sources.whatIsSent")}>
        <div class="cx-section-label">
          <span>{t("sources.whatIsSent")}</span>
        </div>
        <ul class="cx-sent">
          {SENT_KEYS.map((k) => (
            <li>{t(k)}</li>
          ))}
        </ul>
        <button type="button" class="cx-text-button" onClick={() => openCortexSettings(s.app, "privacy")}>
          {t("sources.namesLink")}
        </button>
      </section>
      <ChangeSlot state={change} />
    </div>
  );
}
