/**
 * Reader for a short machine note — question, decision, idea, plan, abandoned idea, concept (CORTEX-UX §5.15;
 * ORIG-05). Owner: E12. Kind line with the kind glyph; the note's text (18/600) as the statement; beside a DOTTED
 * machine rule a model chip "sonnet · 4 Nov" and Trace its sources (no "someone else's words" sentence: the
 * dotted rule, hollow marker and chip say it); the frond node it hangs off ("Part 2 · 14:52–16:30 · messages
 * 39–188", a link into the conversation reader); Quotes (‹n›), each with speaker marker and date, opening the
 * entry; Looks right · Correct (a comment shown as waiting / answered, M7) · More → Open in editor, Copy link.
 * Machine text renders through the inert renderer only.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import type { NoteDetail } from "../../plugin/services";
import { addToken } from "../../state/actions";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { ChangeSlot, copyToClipboard, useChange, useFmt, useLoad } from "../pages/PageFrame";
import { truncate } from "../../shared/text";
import { kindLabel } from "../valueLabels";
import { madeByLine } from "./ConversationReader";
import { KindGlyph, ModelChip, QuoteRow, Section } from "./marks";
import { confirmNote, CorrectBox, isPinned, linkFor, NotInIndex, openInObsidian, openReader, ReaderActions, ReaderLoad, resolveOrdinal, saveComment, setPinned, showInBrain, useIndex, type ReaderMoreItem } from "./readerKit";
import { SafeInline } from "./SafeMarkdown";

const truncateTitle = (x: string) => truncate(x.replace(/\s+/g, " ").trim(), 40);

export function NoteReader(p: { id: string }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const ordinal = resolveOrdinal(s, p.id, index);
  const [nonce, setNonce] = useState(0);
  const detail = useLoad(async () => {
    if (ordinal < 0) throw new NotInIndex(index === null);
    return s.records.note(ordinal);
  }, [p.id, ordinal, nonce]);
  return <ReaderLoad value={detail} ordinal={ordinal}>{(d) => <NoteView id={p.id} ordinal={ordinal} detail={d} reload={() => setNonce((n) => n + 1)} />}</ReaderLoad>;
}

export function NoteView(p: { id: string; ordinal: number; detail: NoteDetail; reload(): void }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const index = useIndex(s);
  const change = useChange();
  const n = p.detail.record;
  const sandbox = s.sandbox.value;
  const canFix = featureOn("corrections") && !sandbox;
  const [status, setStatus] = useState<string | null>(null);
  const [pinned, setPinnedState] = useState(() => isPinned(s, n.id, p.ordinal, index));
  const model = madeByLine(n, fmt);
  const part = useLoad(async () => {
    if (!n.conv || n.part === undefined) return null;
    const c = await s.records.conversation(n.conv);
    const x = c.parts.find((q) => q.n === n.part);
    return x ? { conv: c.record.id, title: c.record.title, part: x } : null;
  }, [n.conv, n.part]);
  const traceSources = () => {
    const ids = p.detail.cites.map((c) => c.entryId);
    if (ids.length === 0) return;
    addToken(leaf.store, { id: `set:sources:${n.id}`, kind: "set", label: t("reader.sourcesToken", { title: truncateTitle(n.title || n.text) }), ids });
  };
  const more: ReaderMoreItem[] = [
    ...(n.file ? [{ value: "editor", label: t("reader.openInEditor"), run: () => (openInObsidian(s.app, n.file, "tab", n.blockId) ? undefined : setStatus(t("reader.openFailed"))) }] : []),
    { value: "link", label: t("reader.copyLink"), run: () => void copyToClipboard(linkFor({ note: n.file })).then((ok) => setStatus(ok ? t("reader.copied") : t("errors.action"))) },
  ];
  const partInfo = part.state === "ready" ? part.value : null;
  return (
    <article class="cx-reader cx-note-reader" data-id={n.id}>
      <div class="cx-reader-head">
        <span class="cx-kind-line">
          <KindGlyph kind={n.kind} />
          {kindLabel(n.kind)}
          <span class="cx-note">{t("reader.machineNote")}</span>
          {p.detail.cites.length > 0 ? <span class="cx-chip">{t("reader.sourcesChip", { n: p.detail.cites.length })}</span> : null}
        </span>
        <h3 class="cx-reader-title">
          <SafeInline text={n.text || n.title} />
        </h3>
        <ReaderActions
          pinned={pinned}
          disabledPin={sandbox}
          onPin={() => {
            const next = !pinned;
            setPinnedState(next);
            setPinned(s, n.id, next).then(
              (rec) =>
                change.post(next ? t("changes.pinned", { title: n.title }) : t("reader.unpin"), async () => {
                  await s.corrections.undo(rec.id, "reader");
                  setPinnedState(!next);
                }),
              () => setPinnedState(!next),
            );
          }}
          onShow={p.ordinal >= 0 ? () => showInBrain(s, leaf, p.ordinal, n.id) : undefined}
          more={more}
        />
      </div>
      <ChangeSlot state={change} />
      {status ? (
        <p class="cx-note" role="status">
          {status}
        </p>
      ) : null}
      <div class="cx-machine-rule cx-note-meta">
        {model ? <ModelChip>{model}</ModelChip> : <span class="cx-note">{t("reader.legacy")}</span>}
        {p.detail.cites.length > 0 ? (
          <button type="button" class="cx-text-button" onClick={traceSources}>
            {t("reader.traceSources")}
          </button>
        ) : null}
      </div>
      {partInfo ? (
        <button type="button" class="cx-text-button cx-part-link" onClick={() => openReader(leaf, "conversation", partInfo.conv)}>
          {partInfo.part.startedAt
            ? t("reader.partLine", { n: partInfo.part.n, span: fmt.span(Date.parse(partInfo.part.startedAt), partInfo.part.endedAt ? Date.parse(partInfo.part.endedAt) : Number.NaN), a: partInfo.part.msgFrom, b: partInfo.part.msgTo })
            : t("reader.partLineNoTime", { n: partInfo.part.n, a: partInfo.part.msgFrom, b: partInfo.part.msgTo })}
        </button>
      ) : null}
      {p.detail.cites.length > 0 ? (
        <Section label={t("reader.quotes", { n: p.detail.cites.length })}>
          <div class="cx-quotes">
            {p.detail.cites.map((c) => (
              <QuoteRow speaker={c.speaker} quote={c.quote} valid={c.valid} date={c.date ? fmt.dateTime(Date.parse(c.date), true) : undefined} onOpen={() => openReader(leaf, "entry", c.entryId, resolveOrdinal(s, c.entryId, index))} />
            ))}
          </div>
        </Section>
      ) : null}
      {featureOn("corrections") ? (
        <CorrectBox
          comments={p.detail.comments}
          disabled={!canFix}
          fmtDate={(ms) => fmt.date(ms, true)}
          onLooksRight={async () => void (await confirmNote(s, n.id))}
          onSave={async (text) => {
            const rec = await saveComment(s, n.id, text);
            change.post(t("reader.correctSaved"), async () => {
              await s.corrections.undo(rec.id, "reader");
              p.reload();
            });
            p.reload();
          }}
        />
      ) : null}
    </article>
  );
}
