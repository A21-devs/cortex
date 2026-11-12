/**
 * Reader for a record entry — your original words (CORTEX-UX §5.14; ORIG-12). Owner: E12.
 * Top to bottom: kind line and title (18/600) with "Cited by ‹n› notes"; the FACTS GRID (speaker, source, project,
 * area, written, imported, date confidence + how the date is known); the verbatim text with the solid rule in the
 * speaker colour, rendered by Cortex's OWN inert renderer (never Obsidian's MarkdownRenderer: markdown is code in
 * this vault, SAFE-01), documents with a Formatted · Source switch and the CC BY line for Roblox docs; the FROND
 * SCRUBBER; attachments with Export file…; labels (machine dashed, yours solid, "+ Add label", inline pickers);
 * notes that cite this; related terms; one HISTORY list; where it lives. Edit as a new version (E) keeps the first
 * wording in History. States: Opening…, left out (Bring it back), missing source, not on this computer yet
 * (Try again), changed at source, unreadable.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { sha256Hex } from "../../shared/sha256";
import { firstLineTitle } from "../../shared/text";
import type { EntryDetail, TextResult } from "../../plugin/services";
import type { CitedByRow } from "../../plugin/services";
import type { EntryRecord, Speaker } from "../../shared/types";
import { addToken, openPage } from "../../state/actions";
import { visibilityParams } from "../../state/selectors";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { openCorrection } from "../modals/CorrectionModals";
import { ChangeSlot, copyToClipboard, isTypingTarget, statsKey, useChange, useFmt, useLoad, type Fmt } from "../pages/PageFrame";
import { fmtBytes, kindLabel, sourceLabel, speakerLabel } from "../valueLabels";
import { dateConfidence, evidenceLine, FactsGrid } from "./FactsGrid";
import { FrondScrubber } from "./FrondScrubber";
import { HistoryList } from "./HistoryList";
import { KindGlyph, Section, SourceIcon, SpeakerMarker } from "./marks";
import { connectedRecordIds, folderPathOf, labelsByPack, partSentence, sourceFolderText } from "./entryContext";
import { shortModel } from "./ConversationReader";
import { idOf, isPinned, LabelEditor, labelFields, linkFor, metaOf, NotInIndex, openReader, PinFocusIcons, PinFocusText, ReaderActions, ReaderLoad, replaceReader, resolveOrdinal, routeOfNoteKind, setPinned, showInBrain, useIndex, type ReaderMoreItem } from "./readerKit";
import { ReadLimitChip } from "./ReadLimitChip";
import { filterRelated, joinTerms, rankRelated, type RelatedHit } from "./relatedRank";
import { readerRouteOf } from "./routes";
import { SafeMarkdown, SecretText } from "./SafeMarkdown";

/** Speaker as shown in the facts grid. */
export function speakerName(speaker: Speaker, model?: string): string {
  return speakerLabel(speaker, model);
}

/** "Message" · "Document passage" · "Document" · "File" · "New entry". */
export function entryKindLabel(r: Pick<EntryRecord, "kind" | "source">): string {
  if (r.source === "written") return t("reader.kindWritten");
  if (r.source === "outcome") return t("reader.kindOutcome");
  switch (r.kind) {
    case "passage":
      return t("reader.kindPassage");
    case "document":
      return t("reader.kindDocument");
    case "file":
      return t("reader.kindFile");
    default:
      return t("reader.kindMessage");
  }
}

/** Title: the entry's own, a passage heading, the first line with Markdown removed, else the conversation's. */
export function entryTitle(r: Pick<EntryRecord, "title" | "passage">, text: TextResult, conversationTitle?: string): string {
  if (r.title && r.title.trim()) return r.title.trim();
  if (r.passage?.heading) return r.passage.heading;
  if (text.ok) {
    const line = firstLineTitle(text.text, 140);
    if (line) return line;
  }
  return conversationTitle ?? t("read.untitled");
}

const isDocument = (r: Pick<EntryRecord, "kind">) => r.kind === "document" || r.kind === "passage" || r.kind === "file";

export function EntryReader(p: { id: string }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const ordinal = resolveOrdinal(s, p.id, index);
  const [nonce, setNonce] = useState(0);
  const detail = useLoad(async () => {
    if (ordinal < 0) throw new NotInIndex(index === null);
    return s.records.entry(ordinal);
  }, [p.id, ordinal, nonce]);
  return <ReaderLoad value={detail} ordinal={ordinal}>{(d) => <EntryView id={p.id} ordinal={ordinal} detail={d} reload={() => setNonce((n) => n + 1)} />}</ReaderLoad>;
}

/** The text block for each TextResult state (§5.14 States). */
function TextState(p: { text: TextResult; record: EntryRecord; fmt: Fmt; leftOut?: { at: number; bringBack?: () => void }; onRetry(): void; onSources(): void }): JSX.Element | null {
  if (p.text.ok) return null;
  switch (p.text.reason) {
    case "excluded":
      return (
        <div class="cx-banner-card" role="status">
          <p>{t("reader.leftOut", { date: p.fmt.date(p.leftOut?.at ?? Date.parse(p.record.addedAt), true) })}</p>
          {p.leftOut?.bringBack ? (
            <button type="button" class="cx-button" onClick={p.leftOut.bringBack}>
              {t("reader.bringBack")}
            </button>
          ) : null}
        </div>
      );
    case "missing":
      return <p class="cx-banner-card">{t("reader.missing", { date: p.fmt.date(Date.parse(p.record.addedAt), true) })}</p>;
    case "not-local":
      return (
        <div class="cx-banner-card" role="status">
          <p>{t("reader.notLocal")}</p>
          <button type="button" class="cx-button" onClick={p.onRetry}>
            {t("app.retry")}
          </button>
        </div>
      );
    case "changed-at-source":
      return (
        <div class="cx-banner-card" role="status">
          <p>{t("reader.changedAtSource")}</p>
          <button type="button" class="cx-text-button" onClick={p.onSources}>
            {t("pages.sources")}
          </button>
        </div>
      );
    case "sample":
      return <p class="cx-banner-card">{t("newEntry.sample")}</p>;
  }
}

export function EntryView(p: { id: string; ordinal: number; detail: EntryDetail; reload(): void }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const index = useIndex(s);
  const change = useChange();
  const d = p.detail;
  const r = d.record;
  const sandbox = s.sandbox.value;
  const canFix = featureOn("corrections") && !sandbox;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"formatted" | "source">("formatted");
  const [status, setStatus] = useState<string | null>(null);
  const [whereOpen, setWhereOpen] = useState(false);
  const [pinned, setPinnedState] = useState(() => isPinned(s, p.id, p.ordinal, index));
  const title = entryTitle(r, d.text, d.conversation?.title);
  const text = d.text.ok ? d.text.text : "";
  const leftOut = (() => {
    try {
      const row = s.corrections.leftOut().find((x) => x.target === p.id || (r.conv !== undefined && x.target === r.conv));
      return row ? { at: Date.parse(row.at), bringBack: canFix ? () => void s.corrections.include(row.correctionId, "reader").then(p.reload, () => change.post(t("errors.action"))) : undefined } : undefined;
    } catch {
      return undefined;
    }
  })();

  const startEdit = () => {
    if (!d.text.ok || !canFix) return;
    setDraft(d.text.text);
    setEditing(true);
  };
  const saveVersion = async () => {
    if (!d.text.ok || saving) return;
    const newText = draft;
    if (newText === d.text.text || newText.trim().length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const rec = await s.corrections.apply({ via: "reader", action: "edit-text", target: p.id, payload: { newText, newTextSha256: sha256Hex(newText), fromVersion: d.text.version, version: 0 } });
      setEditing(false);
      change.post(t("reader.savedVersion", { v: rec.payload.version }), async () => {
        await s.corrections.undo(rec.id, "reader");
        p.reload();
      });
      p.reload();
    } catch {
      setStatus(t("dialogs.failed"));
    } finally {
      setSaving(false);
    }
  };

  const togglePin = () => {
    const next = !pinned;
    setPinnedState(next);
    setPinned(s, p.id, next).then(
      (rec) => change.post(next ? t("changes.pinned", { title }) : t("reader.unpin"), async () => {
        await s.corrections.undo(rec.id, "reader");
        setPinnedState(!next);
      }),
      () => {
        setPinnedState(!next);
        change.post(t("errors.action"));
      },
    );
  };
  const goHistory = () => document.getElementById("cx-sec-history")?.scrollIntoView({ block: "start" });
  const evidence = d.dateEvidence.map((e) => evidenceLine(e, r.source, fmt));
  const more: ReaderMoreItem[] = [
    ...(featureOn("corrections")
      ? [
          { value: "edit", label: `${t("reader.editVersion")} (E)`, disabled: !canFix || !d.text.ok, run: startEdit },
          {
            value: "date",
            label: t("reader.correctDate"),
            disabled: !canFix,
            run: () =>
              openCorrection(s.app, {
                kind: "date",
                target: p.id,
                current: r.writtenAt,
                evidence,
                onSave: async (iso) => {
                  const rec = await s.corrections.apply({ via: "reader", action: "set-date", target: p.id, payload: { writtenAt: iso } });
                  change.post(t("changes.redated", { date: fmt.date(Date.parse(iso)) }), async () => {
                    await s.corrections.undo(rec.id, "reader");
                    p.reload();
                  });
                  p.reload();
                },
              }),
          },
          {
            value: "speaker",
            label: t("reader.correctSpeaker"),
            disabled: !canFix,
            run: () =>
              openCorrection(s.app, {
                kind: "speaker",
                target: p.id,
                current: r.speaker,
                inConversation: r.conv !== undefined,
                onSave: async (speaker, scope) => {
                  const ids = scope === "conversation" && r.conv ? await sameSpeakerIds(r.conv, r.speaker) : [p.id];
                  const done: string[] = [];
                  for (const target of ids) done.push((await s.corrections.apply({ via: "reader", action: "set-speaker", target, payload: { speaker } })).id);
                  change.post(t("changes.speaker", { speaker: speakerLabel(speaker) }), async () => {
                    for (const id of done.reverse()) await s.corrections.undo(id as `k_${string}`, "reader");
                    p.reload();
                  });
                  p.reload();
                },
              }),
          },
          {
            value: "leave-out",
            label: t("reader.leaveOut"),
            disabled: !canFix,
            run: () =>
              openCorrection(s.app, {
                kind: "leave-out",
                target: p.id,
                source: sourceLabel(r.source),
                scopes: r.conv ? ["entry", "conversation", "source"] : ["entry", "source"],
                onSave: async (scope) => {
                  const target = scope === "conversation" && r.conv ? r.conv : scope === "source" ? r.source : p.id;
                  const rec = await s.corrections.exclude(target, scope, "reader");
                  change.post(t("changes.leftOut", { title }), async () => {
                    await s.corrections.include(rec.id, "reader");
                    p.reload();
                  });
                  p.reload();
                },
              }),
          },
        ]
      : []),
    { value: "copy-text", label: t("reader.copyText"), disabled: !d.text.ok, run: () => void copyToClipboard(text).then((ok) => setStatus(ok ? t("reader.copied") : t("errors.action"))) },
    { value: "copy-link", label: t("reader.copyLink"), run: () => void copyToClipboard(linkFor({ entry: p.id })).then((ok) => setStatus(ok ? t("reader.copied") : t("errors.action"))) },
    { value: "read", label: t("reader.showInRead"), run: () => openPage(leaf.store, "read", { tab: "date", filter: title.slice(0, 80) }, true) },
  ];

  async function sameSpeakerIds(conv: string, speaker: Speaker): Promise<string[]> {
    const count = d.conversation?.count ?? 0;
    const out: string[] = [];
    for (let from = 0; from < count; from += 200) {
      const slice = await s.records.conversationSlice(conv, from, Math.min(count, from + 200));
      for (const m of slice) {
        if (m.speaker !== speaker) continue;
        const id = idOf(s, m.ordinal, index);
        if (id) out.push(id);
      }
    }
    return out.length > 0 ? out : [p.id];
  }

  const conv = d.conversation;
  const convLoad = useLoad(async () => (conv ? s.records.conversation(conv.id) : null), [conv?.id]);
  const convDetail = convLoad.state === "ready" ? convLoad.value : null;
  const partStarts = convDetail ? convDetail.parts.slice(1).map((x) => Math.max(0, x.msgFrom - 1)) : undefined;
  const partNote = convDetail ? partSentence(convDetail, r.part, shortModel) : null;
  const folderPath = folderPathOf(r);

  const stepTo = async (i: number) => {
    if (!conv) return;
    try {
      const slice = await s.records.conversationSlice(conv.id, i, i + 1);
      const m = slice[0];
      if (!m) return;
      const id = idOf(s, m.ordinal, index);
      if (id) {
        replaceReader(leaf.store, { kind: "reader", route: "entry", id });
        leaf.store.update("selection", () => ({ ordinal: m.ordinal, id }));
      }
    } catch {
      setStatus(t("errors.reader"));
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === "e" || e.key === "E") && !editing && canFix && d.text.ok) {
      e.preventDefault();
      startEdit();
    }
  };

  return (
    <article class="cx-reader cx-entry-reader" data-id={p.id} onKeyDown={onKey}>
      <div class="cx-reader-head">
        <span class="cx-kind-line">
          {entryKindLabel(r)}
          {d.citedBy.length > 0 ? <span class="cx-chip">{t("reader.citedByChip", { n: d.citedBy.length })}</span> : null}
          <ReadLimitChip id={d.record.id} reads={d.reads.at ?? []} />
        </span>
        <h3 class="cx-reader-title">{title}</h3>
        <span class="cx-head-links">
          {featureOn("corrections") && d.text.ok ? (
            <button type="button" class="cx-text-button" aria-pressed={editing} disabled={!canFix || editing} title="E" onClick={startEdit}>
              {t("reader.editLink")}
            </button>
          ) : null}
          <button type="button" class="cx-text-button" onClick={goHistory}>
            {t("reader.history")}
          </button>
        </span>
        <p class="cx-source-folder" title={sourceFolderText(r)}>
          <SourceIcon source={r.source} label />
          <span aria-hidden="true">·</span>
          {folderPath ? (
            <button type="button" class="cx-text-button" title={t("reader.folderOpenRead")} onClick={() => openPage(leaf.store, "read", { tab: "folder", folder: folderPath }, true)}>
              {folderPath}
            </button>
          ) : (
            <span>{t("reader.inboxFolder")}</span>
          )}
        </p>
        {partNote ? (
          <button type="button" class="cx-text-button cx-part-note" onClick={() => conv && openReader(leaf, "conversation", conv.id)}>
            {partNote.text}
          </button>
        ) : null}
        <ReaderActions
          extra={<PinFocusIcons pinned={pinned} disabledPin={sandbox} onPin={togglePin} onShow={() => showInBrain(s, leaf, p.ordinal, p.id)} />}
          more={more}
        />
      </div>
      <ChangeSlot state={change} />
      {status ? (
        <p class="cx-note" role="status">
          {status}
        </p>
      ) : null}

      <FactsGrid
        speaker={r.speaker}
        model={r.speakerDetail}
        source={r.source}
        project={r.project}
        space={r.space}
        written={r.writtenAt ? Date.parse(r.writtenAt) : undefined}
        imported={Date.parse(r.addedAt)}
        evidence={d.dateEvidence}
        confidence={dateConfidence(r.writtenAt, d.dateEvidence)}
        fmt={fmt}
        {...(s.sandbox.value ? {} : { onProve: () => void (s.app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands?.executeCommandById?.("cortex:prove-entry") })}
      />

      <TextState text={d.text} record={r} fmt={fmt} leftOut={leftOut} onRetry={() => void s.sources.fetchNow().catch(() => undefined).finally(p.reload)} onSources={() => openPage(leaf.store, "sources", undefined, true)} />

      {d.text.ok ? (
        editing ? (
          <div class="cx-edit-version">
            <p class="cx-banner-card" role="note">
              {t("reader.newVersionBanner")}
            </p>
            <textarea
              class="cx-textarea"
              aria-label={t("reader.editVersion")}
              value={draft}
              onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void saveVersion();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(false);
                }
              }}
            />
            <div class="cx-row-buttons">
              <button type="button" class="cx-button is-primary" disabled={saving || draft.trim().length === 0} onClick={() => void saveVersion()}>
                {saving ? t("dialogs.saving") : t("reader.saveVersion")}
              </button>
              <button type="button" class="cx-button" onClick={() => setEditing(false)}>
                {t("reader.cancelEdit")}
              </button>
            </div>
          </div>
        ) : (
          <div class={`cx-verbatim is-${r.speaker}`}>
            {isDocument(r) ? (
              <div class="cx-segmented is-small" role="radiogroup" aria-label={t("reader.formatted")}>
                <button type="button" role="radio" aria-checked={view === "formatted"} class={`cx-seg${view === "formatted" ? " is-on" : ""}`} onClick={() => setView("formatted")}>
                  {t("reader.formatted")}
                </button>
                <button type="button" role="radio" aria-checked={view === "source"} class={`cx-seg${view === "source" ? " is-on" : ""}`} onClick={() => setView("source")}>
                  {t("reader.sourceText")}
                </button>
              </div>
            ) : null}
            {view === "source" && isDocument(r) ? (
              <pre class="cx-source-text">
                <SecretText text={text} secrets={d.secrets} reveal={(m) => s.records.revealHeld(p.id, m)} />
              </pre>
            ) : (
              <div class="cx-read-scroll">
                <SafeMarkdown text={text} document={isDocument(r)} secrets={d.secrets} reveal={(m) => s.records.revealHeld(p.id, m)} />
              </div>
            )}
            {r.licence ? <p class="cx-licence">{r.licence}</p> : null}
          </div>
        )
      ) : null}

      <div class="cx-entry-foot">
        {conv && conv.count > 0 ? (
          <button type="button" class="cx-text-button" onClick={() => openReader(leaf, "thread", p.id)}>
            {t("reader.readFull")}
          </button>
        ) : null}
        <PinFocusText pinned={pinned} disabledPin={sandbox} onPin={togglePin} onShow={() => showInBrain(s, leaf, p.ordinal, p.id)} />
      </div>

      {conv && conv.count > 0 ? (
        <Section id="cx-sec-conversation" collapsible defaultOpen label={t("reader.inConversation")} right={<span class="cx-mono">{t("reader.position", { i: conv.index + 1, n: conv.count })}</span>}>
          <FrondScrubber
            speakers={conv.speakers}
            index={conv.index}
            partStarts={partStarts}
            onStep={(i) => void stepTo(i)}
            describe={(i) => t("reader.scrubValue", { i: i + 1, n: conv.count, speaker: speakerLabel(conv.speakers[i] ?? "other").toLowerCase(), date: i === conv.index && r.writtenAt ? fmt.dateTime(Date.parse(r.writtenAt), true) : "" }).replace(/, $/, "")}
          />
          <div class="cx-scrub-foot">
            <span class="cx-note">{t("reader.scrubKey")}</span>
            <button type="button" class="cx-text-button" onClick={() => openReader(leaf, "thread", p.id)}>
              {t("reader.openConversation")}
            </button>
          </div>
        </Section>
      ) : null}

      {r.attachments && r.attachments.length > 0 ? (
        <Section label={t("reader.attachments")}>
          {r.attachments.map((a) => (
            <div class="cx-attachment">
              <span class="cx-attachment-name">{a.name}</span>
              <span class="cx-mono cx-note">{fmtBytes(a.bytes)}</span>
              {a.path ? (
                <button type="button" class="cx-button" onClick={() => void s.sources.exportFile(a.path as string).catch(() => setStatus(t("errors.action")))}>
                  {t("reader.exportFile")}
                </button>
              ) : (
                <span class="cx-note">{t("reader.textOnly")}</span>
              )}
            </div>
          ))}
        </Section>
      ) : null}

      <LabelsSection id={p.id} detail={d} canFix={canFix} fmt={fmt} onChanged={(summary, undo) => change.post(summary, undo)} reload={p.reload} />

      <FolderSection id={p.id} ordinal={p.ordinal} path={folderPath} />

      <ConnectedRecords id={p.id} detail={d} />

      <CitedBy rows={d.citedBy} fmt={fmt} />

      {d.related.length > 0 ? <Related id={p.id} terms={d.related} fmt={fmt} /> : null}

      <ModelActivity detail={d} fmt={fmt} />

      <Section id="cx-sec-history" label={t("reader.history")}>
        <HistoryList
          items={d.history}
          source={r.source}
          fmt={fmt}
          loadDiff={async (v) => {
            const [after, before] = await Promise.all([s.records.entryText(p.ordinal, v), s.records.entryText(p.ordinal, Math.max(1, v - 1))]);
            return after.ok && before.ok ? { before: before.text, after: after.text } : null;
          }}
        />
      </Section>

      {d.storage.path ? (
        <Section
          label={t("reader.whereItLives")}
          right={
            <button type="button" class="cx-text-button" aria-expanded={whereOpen} onClick={() => setWhereOpen(!whereOpen)}>
              {whereOpen ? t("reader.showLess") : t("reader.showAll")}
            </button>
          }
        >
          {whereOpen ? (
            <div class="cx-where">
              <code class="cx-mono">{storageLine(d.storage)}</code>
              <button type="button" class="cx-text-button" onClick={() => void copyToClipboard(d.storage.path).then((ok) => setStatus(ok ? t("reader.copied") : t("errors.action")))}>
                {t("reader.copyPath")}
              </button>
            </div>
          ) : null}
        </Section>
      ) : null}
    </article>
  );
}

/** "Where it lives": store path and line or byte range. */
export function storageLine(st: EntryDetail["storage"]): string {
  if (st.line !== undefined) return t("reader.storeLine", { path: st.path, line: st.line });
  if (st.byteRange) return t("reader.storeBytes", { path: st.path, from: st.byteRange[0], to: st.byteRange[1] });
  return st.path;
}

function LabelsSection(p: { id: string; detail: EntryDetail; canFix: boolean; fmt: Fmt; onChanged(summary: string, undo: () => Promise<void>): void; reload(): void }): JSX.Element | null {
  const s = useServices();
  const [editing, setEditing] = useState(false);
  const [focusField, setFocusField] = useState<string | undefined>(undefined);
  const r = p.detail.record;
  const { blocks, setCount } = labelsByPack(p.detail.labels, { inConversation: r.conv !== undefined });
  const machine = p.detail.labels.find((l) => !l.byUser && l.label.state === "set" && !l.label.supersededBy);
  const by = machine?.label.by;
  const model = by && "model" in by ? by.model : undefined;
  const modelLine =
    machine && model
      ? machine.label.target !== p.id
        ? t("reader.fromConversation", { model, pack: `${machine.label.pack} ${machine.label.packVersion}`, date: p.fmt.date(Date.parse(machine.label.at), true) })
        : t("reader.labelModel", { model, pack: `${machine.label.pack} ${machine.label.packVersion}`, date: p.fmt.date(Date.parse(machine.label.at), true) })
      : null;
  // Nothing to show and nothing to add: no empty heading.
  if (blocks.length === 0 && !p.canFix && !modelLine && !editing) return null;
  return (
    <Section
      id="cx-sec-labels"
      collapsible
      defaultOpen
      count={setCount}
      label={t("reader.labelsByPack")}
      right={
        p.canFix && !editing ? (
          <button type="button" class="cx-text-button" onClick={() => setEditing(true)}>
            {t("reader.editLabels")}
          </button>
        ) : null
      }
    >
      {editing ? (
        <LabelEditor
          fields={labelFields(p.detail.labels, { entryId: p.id, conversationId: r.conv })}
          {...(focusField ? { focusField } : {})}
          onCancel={() => (setEditing(false), setFocusField(undefined))}
          onSave={async (changes) => {
            const ids: string[] = [];
            for (const c of changes) ids.push((await s.corrections.apply({ via: "reader", action: "set-label", target: c.target, payload: { pack: c.pack, packVersion: c.packVersion, field: c.field, value: c.value } })).id);
            setEditing(false);
            setFocusField(undefined);
            if (ids.length > 0)
              p.onChanged(t("changes.relabelled", { n: ids.length }), async () => {
                for (const id of ids.reverse()) await s.corrections.undo(id as `k_${string}`, "reader");
                p.reload();
              });
            p.reload();
          }}
        />
      ) : (
        <>
          <PackTable
            blocks={blocks}
            {...(p.canFix
              ? {
                  onAdd: (pack: string, field: string) => {
                    setFocusField(`${pack}/${field}`);
                    setEditing(true);
                  },
                }
              : {})}
          />
          <div class="cx-chip-row">
            {p.canFix ? (
              <button type="button" class="cx-chip is-yours cx-add-label" onClick={() => setEditing(true)}>
                {t("reader.addLabel")}
              </button>
            ) : null}
          </div>
          {modelLine ? (
            <p class="cx-model-line">
              <span class="cx-model-chip-glyph" aria-hidden="true">
                ◌
              </span>{" "}
              {modelLine}
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}

/**
 * One table for the entry's label fields: a row per field of every installed pack that applies, the value (with its
 * author) or a muted "blank" with a "+" that opens the editor on that field, and the pack with its version on the row.
 */
export function PackTable(p: { blocks: ReturnType<typeof labelsByPack>["blocks"]; onAdd?: (pack: string, field: string) => void }): JSX.Element {
  return (
    <table class="cx-pack-rows">
      <thead>
        <tr>
          <th scope="col">{t("reader.colField")}</th>
          <th scope="col">{t("reader.colValue")}</th>
          <th scope="col">{t("reader.colPack")}</th>
        </tr>
      </thead>
      <tbody>
        {p.blocks.flatMap((b) =>
          b.rows.map((row) => (
            <tr data-pack={b.pack.id} data-field={row.field} class={row.value ? undefined : "is-blank"}>
              <th scope="row">{row.label}</th>
              <td>
                {row.value ? (
                  <span class={`cx-chip ${row.value.byUser ? "is-yours" : "is-machine"}${row.value.held ? " is-held" : ""}${row.value.rule ? " is-rule" : ""}`} title={row.value.rule ? t("reader.labelledByRule") : t("reader.labelledBy", { who: row.value.who })}>
                    <span class="cx-chip-value">{row.value.text}</span>
                    <span class="cx-chip-by cx-mono">{row.value.who}</span>
                  </span>
                ) : (
                  <span class="cx-blank">
                    <span class="cx-note">{t("reader.blank")}</span>
                    {p.onAdd ? (
                      <button type="button" class="cx-blank-add" aria-label={t("reader.addField", { field: row.label })} title={t("reader.addField", { field: row.label })} onClick={() => p.onAdd?.(b.pack.id, row.field)}>
                        +
                      </button>
                    ) : null}
                  </span>
                )}
              </td>
              <td class="cx-pack-name cx-mono" title={b.pack.description}>
                {t("reader.packLine", { pack: b.pack.id, version: b.pack.version })}
              </td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}

function CitedBy(p: { rows: readonly CitedByRow[]; fmt: Fmt }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  return (
    <Section id="cx-sec-connected-notes" collapsible defaultOpen count={p.rows.length} label={t("reader.connectedNotes")}>
      {p.rows.length === 0 ? <p class="cx-note">{t("reader.modelNothing")}</p> : null}
      <ul class="cx-rows">
        {p.rows.map((row) => {
          const isMap = row.kind === "hub";
          const meta = row.date ? t("reader.citedMetaDate", { kind: kindLabel(row.kind), date: p.fmt.date(Date.parse(row.date), true) }) : kindLabel(row.kind);
          return (
            <li>
              <button type="button" class="cx-row" onClick={() => openReader(leaf, routeOfNoteKind(row.kind), row.id, resolveOrdinal(s, row.id, index))}>
                <KindGlyph kind={isMap ? "map" : row.kind} />
                <span class="cx-row-title">{row.title}</span>
                <span class="cx-row-meta">{meta}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

const RELATED_ROWS = 8;

/**
 * Up to 8 other entries ranked by how many of this entry's shared terms they use, each row saying which ("both mention a, b
 * and c"). The term chips filter the list; the chip that is on can also be traced.
 */
function Related(p: { id: string; terms: readonly { term: string; count: number }[]; fmt: Fmt }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  const [term, setTerm] = useState("");
  const all = useLoad(
    async (signal) => {
      const ui = leaf.store.get("ui");
      const view = leaf.store.get("view");
      const visibility = visibilityParams(ui, view);
      const hits: RelatedHit[] = await Promise.all(
        p.terms.map(async (x, i) => {
          const res = await s.worker.call(statsKey(leaf.viewId, `related-${i}`), "search", { query: x.term, limit: 24, visibility }, { signal });
          return { term: x.term, ordinals: res.top.entries };
        }),
      );
      return rankRelated(hits, (o) => idOf(s, o, index) === p.id);
    },
    [p.terms.map((x) => x.term).join("|"), p.id],
  );
  const rows = all.state === "ready" ? filterRelated(all.value, term, RELATED_ROWS) : [];
  return (
    <Section
      id="cx-sec-related"
      collapsible
      defaultOpen
      label={t("reader.related")}
      right={
        term ? (
          <button type="button" class="cx-text-button" onClick={() => addToken(leaf.store, { id: `text:${term}`, kind: "text", text: term, label: `“${term}”` })}>
            {t("reader.traceTerm", { term })}
          </button>
        ) : undefined
      }
    >
      <div class="cx-chip-row" role="group" aria-label={t("reader.related")}>
        {p.terms.map((x) => (
          <button type="button" aria-pressed={x.term === term} class={`cx-term${x.term === term ? " is-on" : ""}`} onClick={() => setTerm(x.term === term ? "" : x.term)}>
            {x.term} <span class="cx-mono">{x.count}</span>
          </button>
        ))}
      </div>
      {all.state === "ready" && rows.length === 0 ? <p class="cx-note">{t("reader.relatedNone")}</p> : null}
      {rows.length > 0 ? (
        <ul class="cx-rows cx-related-rows">
          {rows.map((o) => {
            const m = metaOf(s, o.ordinal);
            if (!m) return null;
            return (
              <li>
                <button type="button" class="cx-row" onClick={() => openReader(leaf, readerRouteOf(m.kind), m.id, o.ordinal)}>
                  <SpeakerMarker speaker={m.speaker} />
                  <span class="cx-row-title">{m.conversation?.title ?? m.title}</span>
                  <span class="cx-row-meta">{t("reader.relatedRow", { date: m.writtenAt ? p.fmt.date(Date.parse(m.writtenAt), true) : t("dims.undated"), terms: joinTerms(o.terms) })}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Section>
  );
}

const FOLDER_ROWS = 12;

/** Other items in this entry's folder (up to 12), with a link that opens Read on the folder. Loads only while open. */
function FolderSection(p: { id: string; ordinal: number; path: string }): JSX.Element | null {
  if (p.path === "") return null;
  return (
    <Section id="cx-sec-folder" collapsible defaultOpen={false} label={t("reader.sectionFolder")}>
      <FolderRows id={p.id} path={p.path} />
    </Section>
  );
}

function FolderRows(p: { id: string; path: string }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  const ui = leaf.store.get("ui");
  const view = leaf.store.get("view");
  const rows = useLoad(
    async (signal) => {
      const res = await s.worker.call(statsKey(leaf.viewId, "readerFolder"), "stats", { kind: "read", view: "folder", folder: p.path, preset: "all", pinnedOnly: false, sort: "newest", query: "", offset: 0, limit: FOLDER_ROWS + 2, visibility: visibilityParams(ui, view) }, { signal });
      if (res.kind !== "read") return { total: 0, ordinals: [] as number[] };
      const ordinals = res.rows.map((r) => r.ordinal).filter((o) => idOf(s, o, index) !== p.id);
      return { total: res.total, ordinals: ordinals.slice(0, FOLDER_ROWS) };
    },
    [p.path, p.id, index],
  );
  const seeAll = (
    <button type="button" class="cx-text-button" onClick={() => openPage(leaf.store, "read", { tab: "folder", folder: p.path }, true)}>
      {t("reader.folderSeeAll")}
    </button>
  );
  if (rows.state !== "ready") return <p class="cx-note">{t("app.opening")}</p>;
  return (
    <>
      <p class="cx-note cx-mono">{p.path}</p>
      {rows.value.ordinals.length === 0 ? <p class="cx-note">{t("reader.folderNone")}</p> : <ItemRows ordinals={rows.value.ordinals} />}
      {seeAll}
    </>
  );
}

/** Rows that open an item's reader: speaker marker, title, source. */
function ItemRows(p: { ordinals: readonly number[] }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  return (
    <ul class="cx-rows">
      {p.ordinals.map((o) => {
        const m = metaOf(s, o);
        if (!m) return null;
        return (
          <li>
            <button type="button" class="cx-row" onClick={() => openReader(leaf, readerRouteOf(m.kind), m.id, o)}>
              <SpeakerMarker speaker={m.speaker} />
              <span class="cx-row-title">{m.conversation?.title ?? (m.title || t("read.untitled"))}</span>
              <span class="cx-row-meta">{sourceLabel(m.source)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Records cited alongside this one by the notes that cite it, and the entry it replaced. */
function ConnectedRecords(p: { id: string; detail: EntryDetail }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const noteRows = p.detail.citedBy.filter((c) => c.kind !== "hub").slice(0, 6);
  const found = useLoad(async () => {
    const groups = await Promise.all(
      noteRows.map(async (row) => {
        const o = resolveOrdinal(s, row.id, index);
        if (o < 0) return [] as string[];
        try {
          return (await s.records.note(o)).cites.map((c) => c.entryId as string);
        } catch {
          return [] as string[];
        }
      }),
    );
    const ids = connectedRecordIds(p.id, groups, p.detail.record.supersedes);
    return ids.map((id) => resolveOrdinal(s, id, index)).filter((o) => o >= 0 && metaOf(s, o) !== undefined);
  }, [p.id, index, noteRows.map((x) => x.id).join(",")]);
  const list = found.state === "ready" ? found.value : found.state === "loading" ? found.previous : undefined;
  return (
    <Section id="cx-sec-connected-records" collapsible defaultOpen={false} count={list?.length ?? 0} label={t("reader.connectedRecords")}>
      {list && list.length > 0 ? <ItemRows ordinals={list} /> : <p class="cx-note">{t("reader.connectedRecordsNone")}</p>}
    </Section>
  );
}

/** The model calls that read this entry and the labels models set on it (reads cache and labels; none yet = "Nothing yet"). */
function ModelActivity(p: { detail: EntryDetail; fmt: Fmt }): JSX.Element {
  const d = p.detail;
  const made = labelsByPack(d.labels, { inConversation: d.record.conv !== undefined }).blocks.flatMap((b) => b.rows.filter((r) => r.value && !r.value.byUser).map((r) => ({ field: r.label, model: r.value?.who ?? "" })));
  const reads = d.reads.count;
  const count = reads + made.length;
  return (
    <Section id="cx-sec-model-activity" collapsible defaultOpen={false} count={count} label={t("reader.modelActivity")}>
      {count === 0 ? <p class="cx-note">{t("reader.modelNothing")}</p> : null}
      <ul class="cx-rows cx-activity">
        {reads > 0 ? (
          <li class="cx-activity-row">
            {d.reads.last
              ? t("reader.modelReads", { models: d.reads.models.map(shortModel).join(", "), n: reads, date: p.fmt.date(Date.parse(d.reads.last), true) })
              : t("reader.modelReadsNoDate", { models: d.reads.models.map(shortModel).join(", "), n: reads })}
          </li>
        ) : null}
        {made.map((m) => (
          <li class="cx-activity-row">{t("reader.modelLabelled", { field: m.field, model: shortModel(m.model) })}</li>
        ))}
      </ul>
    </Section>
  );
}
