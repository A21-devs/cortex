/**
 * Conversation reader — the FROND (CORTEX-UX §5.15; ORIG-05). Owner: E12. Data: RecordReader.conversation().
 *  1. the gist is the subtitle: one sentence beside a dotted machine rule, with a model chip "sonnet · 4 Nov";
 *  2. machine facets appear ONCE as a row of dashed chips (work, outcome, project, topics); your labels join the
 *     same row as solid chips;
 *  3. a facts line: source · messages · time span · area;
 *  4. the body is a vertical STEM: each part is a hollow node with its title and "3 Nov 14:05–14:40 · messages
 *     1–38"; the notes taken from that part hang off the node as rows with kind glyphs and expand to their quotes;
 *  5. your corrections sit inline at the node they changed, with a solid rule ("Your fix");
 *  6. Open conversation (the whole thread) · Looks right · Correct (a comment the next summary must answer).
 * No summary yet: the stem is drawn from the parts alone. While a refresh runs the current summary stays.
 * Opening a conversation ticks "Open one conversation frond" on the first-run checklist (§5.28).
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { NONE32, type DataIndex } from "../../shared/index-format";
import type { ConversationDetail, CortexServices } from "../../plugin/services";
import type { CorrectionRecord, NoteRecord } from "../../shared/types";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { tickChecklist } from "../deviceState";
import { openCorrection } from "../modals/CorrectionModals";
import { ChangeSlot, copyToClipboard, useChange, useFmt, useLoad, type Fmt } from "../pages/PageFrame";
import { gatherByKind, partChips, stemNotes, topicsOf, uniqueSources, type PartChip } from "./conversationParts";
import { speakerLabel } from "../valueLabels";
import { AreaDot, KindGlyph, ModelChip, QuoteRow, Section, SourceIcon } from "./marks";
import { confirmNote, CorrectBox, isPinned, labelValueText, linkFor, metaOf, NotInIndex, openInObsidian, openReader, PinFocusIcons, PinFocusText, ReaderActions, ReaderLoad, resolveOrdinal, saveComment, setPinned, showInBrain, useIndex, type ReaderMoreItem } from "./readerKit";
import { SafeInline } from "./SafeMarkdown";

/** "14:05–14:40 · messages 1–38" (the node's mono line). */
export function partSpan(from: string, to: string, a: number, b: number): string {
  return t("reader.span", { from, to, a, b });
}

/** The conversation behind a reader id: a conversation id, a summary note, or one of its messages. */
export async function resolveConversation(s: CortexServices, id: string, index: DataIndex | null): Promise<string> {
  if (id.startsWith("c_")) return id;
  const ordinal = resolveOrdinal(s, id, index);
  if (ordinal < 0) throw new NotInIndex(index === null);
  const m = metaOf(s, ordinal);
  if (m?.conversation?.id) return m.conversation.id;
  if (index) {
    const row = index.cols.conv[ordinal];
    if (row !== undefined && row !== NONE32) return index.convs.get(row).id;
  }
  if (id.startsWith("n_")) {
    const note = await s.records.note(ordinal);
    if (note.record.conv) return note.record.conv;
  }
  throw new NotInIndex(false);
}

/** Model chip text for machine-written notes: "sonnet · 4 Nov". */
export function madeByLine(note: Pick<NoteRecord, "madeBy">, fmt: Fmt): string | null {
  const m = note.madeBy;
  if ("legacy" in m) return null;
  return `${shortModel(m.model)} · ${fmt.date(Date.parse(m.at), true)}`;
}

/** "claude-sonnet-5-5" → "sonnet"; aliases stay as they are. */
export function shortModel(model: string): string {
  const m = /(haiku|sonnet|opus)/i.exec(model);
  return m?.[1]?.toLowerCase() ?? model;
}

/** Facet chips from the summary's machine facets (work, outcome, project, topics). */
export function facetChips(facets: NoteRecord["facets"]): { field: string; value: string }[] {
  if (!facets) return [];
  const order = ["work", "outcome", "project", "topics"];
  const keys = Object.keys(facets).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const out: { field: string; value: string }[] = [];
  for (const k of keys) {
    const v = facets[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0) || v === "") continue;
    out.push({ field: k, value: Array.isArray(v) ? v.join(" · ") : v });
  }
  return out;
}

/** The words of a "Your fix" row for a correction (null for corrections that change nothing visible). */
export function fixLine(c: CorrectionRecord, fmt: Fmt): string | null {
  switch (c.action) {
    case "edit-text": {
      const p = c.payload as CorrectionRecord<"edit-text">["payload"];
      const one = p.newText.replace(/\s+/g, " ").trim();
      return one.length > 160 ? `${one.slice(0, 159)}…` : one;
    }
    case "set-date": {
      const p = c.payload as CorrectionRecord<"set-date">["payload"];
      return p.writtenAt ? t("changes.redated", { date: fmt.date(Date.parse(p.writtenAt)) }) : null;
    }
    case "set-speaker":
      return t("changes.speaker", { speaker: speakerLabel((c.payload as CorrectionRecord<"set-speaker">["payload"]).speaker) });
    case "set-label": {
      const p = c.payload as CorrectionRecord<"set-label">["payload"];
      return t("checks.fieldValue", { field: p.field, value: labelValueText(p.value) });
    }
    case "comment":
      return (c.payload as CorrectionRecord<"comment">["payload"]).text;
    case "exclude":
      return t("reader.histLeftOut");
    default:
      return null;
  }
}

export function ConversationReader(p: { id: string }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    s.device.update((d) => tickChecklist(d, "open-frond"));
    s.bus.emit("checklist:step", { step: "open-frond" });
  }, []);
  const detail = useLoad(async () => s.records.conversation(await resolveConversation(s, p.id, index)), [p.id, index === null, nonce]);
  return <ReaderLoad value={detail}>{(d) => <ConversationView id={p.id} detail={d} reload={() => setNonce((n) => n + 1)} />}</ReaderLoad>;
}

export function ConversationView(p: { id: string; detail: ConversationDetail; reload(): void }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const index = useIndex(s);
  const change = useChange();
  const d = p.detail;
  const c = d.record;
  const gist = d.gist;
  const sandbox = s.sandbox.value;
  const canFix = featureOn("corrections") && !sandbox;
  const [status, setStatus] = useState<string | null>(null);
  const [pinned, setPinnedState] = useState(() => isPinned(s, c.id, -1, index));
  const [passagesOpen, setPassagesOpen] = useState(false);
  const noteCount = d.parts.reduce((n, part) => n + part.notes.length, 0);
  const gistOrdinal = gist ? resolveOrdinal(s, gist.id, index) : -1;
  const anchorOrdinal = gistOrdinal >= 0 ? gistOrdinal : resolveOrdinal(s, p.id, index);
  const anchorId = gistOrdinal >= 0 && gist ? gist.id : p.id;
  const facets = gist ? facetChips(gist.facets) : [];
  const yourLabels = d.corrections.filter((x) => x.action === "set-label" && !x.undoes).map((x) => x.payload as CorrectionRecord<"set-label">["payload"]);
  const refreshing = gist?.state === "stale" && s.shared.slices.activity.value.jobs.some((j) => j.kind === "gist");
  const model = gist ? madeByLine(gist, fmt) : null;
  const start = c.startedAt ? Date.parse(c.startedAt) : Number.NaN;
  const end = c.endedAt ? Date.parse(c.endedAt) : Number.NaN;
  const fixesByPart = placeFixes(s, d, index, fmt);

  const togglePin = () => {
    const next = !pinned;
    setPinnedState(next);
    setPinned(s, c.id, next).then(
      (rec) =>
        change.post(next ? t("changes.pinned", { title: c.title }) : t("reader.unpin"), async () => {
          await s.corrections.undo(rec.id, "reader");
          setPinnedState(!next);
        }),
      () => setPinnedState(!next),
    );
  };
  const focusBrain = anchorOrdinal >= 0 ? () => showInBrain(s, leaf, anchorOrdinal, anchorId) : undefined;
  const topics = topicsOf(gist?.facets);
  const ideas = gatherByKind(d.parts, ["idea"]);
  const decisions = gatherByKind(d.parts, ["decision"]);
  const fixes = [...fixesByPart.values()].flat();
  const passages = uniqueSources(d.parts);
  const tagger = gist && !("legacy" in gist.madeBy) ? shortModel(gist.madeBy.model) : null;
  const openEntry = (id: string) => openReader(leaf, "entry", id, resolveOrdinal(s, id, index));
  const openNote = (n: NoteRecord) => openReader(leaf, "note", n.id, resolveOrdinal(s, n.id, index));
  const showPassages = () => {
    setPassagesOpen(true);
    setTimeout(() => document.getElementById("cx-sec-conv-passages")?.scrollIntoView({ block: "start" }), 0);
  };

  const more: ReaderMoreItem[] = [
    ...(gist && gist.file ? [{ value: "editor", label: t("reader.openInEditor"), run: () => (openInObsidian(s.app, gist.file, "tab") ? undefined : setStatus(t("reader.openFailed"))) }] : []),
    { value: "link", label: t("reader.copyLink"), run: () => void copyToClipboard(gist && gist.file ? linkFor({ note: gist.file }) : linkFor({ entry: p.id.startsWith("e_") ? p.id : anchorId })).then((ok) => setStatus(ok ? t("reader.copied") : t("errors.action"))) },
    ...(featureOn("corrections")
      ? [
          {
            value: "leave-out",
            label: t("reader.leaveOut"),
            disabled: !canFix,
            run: () =>
              openCorrection(s.app, {
                kind: "leave-out",
                target: c.id,
                source: c.source,
                scopes: ["conversation", "source"],
                onSave: async (scope) => {
                  const rec = await s.corrections.exclude(scope === "source" ? c.source : c.id, scope === "source" ? "source" : "conversation", "reader");
                  change.post(t("changes.leftOut", { title: c.title }), async () => {
                    await s.corrections.include(rec.id, "reader");
                    p.reload();
                  });
                  p.reload();
                },
              }),
          },
        ]
      : []),
  ];

  return (
    <article class="cx-reader cx-conversation-reader" data-id={c.id}>
      <div class="cx-reader-head">
        <span class="cx-kind-line">
          <SourceIcon source={c.source} />
          {t("routes.conversation")}
          <span class="cx-chip">{t("reader.messagesChip", { messages: c.entryCount.toLocaleString("en-GB"), notes: noteCount })}</span>
        </span>
        <h3 class="cx-reader-title">{c.title}</h3>
        <ReaderActions extra={<PinFocusIcons pinned={pinned} disabledPin={sandbox} onPin={togglePin} onShow={focusBrain} />} more={more} />
      </div>
      <ChangeSlot state={change} />
      {status ? (
        <p class="cx-note" role="status">
          {status}
        </p>
      ) : null}

      {facets.length > 0 || yourLabels.length > 0 ? (
        <div class="cx-conv-block">
          {tagger && facets.length > 0 ? <p class="cx-conv-tagged">{t("reader.convTaggedBy", { model: tagger })}</p> : null}
          <div class="cx-chip-row cx-facets" aria-label={t("reader.convTags")}>
            {facets.map((f) => (
              <span class="cx-chip is-machine">
                <span class="cx-chip-field">{f.field}</span> <span class="cx-chip-value">{f.value}</span>
              </span>
            ))}
            {yourLabels.map((l) => (
              <span class="cx-chip is-yours">
                <span class="cx-chip-field">{l.field}</span> <span class="cx-chip-value">{labelValueText(l.value)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {refreshing ? (
        <div class="cx-progress-line" role="status">
          <span class="cx-progress-bar" aria-hidden="true" />
          <span class="cx-note">{t("reader.refreshing", { model: shortModel(s.settings.value.agents.models.summaries) })}</span>
        </div>
      ) : null}

      {gist ? (
        <div class="cx-gist cx-machine-rule">
          <p class="cx-gist-text">
            <SafeInline text={gist.text} />
          </p>
          {model ? <ModelChip>{model}</ModelChip> : null}
        </div>
      ) : (
        <p class="cx-note">{t("reader.noSummary")}</p>
      )}

      <p class="cx-facts-line">
        <SourceIcon source={c.source} label />
        <span class="cx-mono">{t("reader.messagesCount", { n: c.entryCount.toLocaleString("en-GB") })}</span>
        {Number.isFinite(start) ? <span class="cx-mono">{fmt.span(start, end)}</span> : null}
        <AreaDot space={c.space} />
      </p>

      <ol class="cx-stem" aria-label={t("routes.conversation")}>
        {d.parts.map((part, i) => (
          <StemNode part={part} hasGist={gist !== undefined} chips={gist ? partChips(part, topics) : []} fmt={fmt} onOpenEntry={openEntry} onOpenNote={openNote} />
        ))}
      </ol>

      <button type="button" class="cx-text-button cx-conv-readfull" onClick={() => openReader(leaf, "thread", c.id)}>
        {t("reader.readFull")}
      </button>

      {ideas.length > 0 ? (
        <Section id="cx-sec-conv-ideas" label={t("reader.ideas")}>
          <ul class="cx-note-list">
            {ideas.map((n) => (
              <NoteRow note={n} fmt={fmt} onOpenEntry={openEntry} onOpenNote={openNote} />
            ))}
          </ul>
        </Section>
      ) : null}
      {decisions.length > 0 ? (
        <Section id="cx-sec-conv-decisions" label={t("reader.decisions")}>
          <ul class="cx-note-list">
            {decisions.map((n) => (
              <NoteRow note={n} fmt={fmt} onOpenEntry={openEntry} onOpenNote={openNote} />
            ))}
          </ul>
        </Section>
      ) : null}
      {fixes.length > 0 ? (
        <Section id="cx-sec-conv-fixes" label={t("reader.youSteppedIn")}>
          <ul class="cx-fixes">
            {fixes.map((f) => (
              <FixRow fix={f} fmt={fmt} />
            ))}
          </ul>
        </Section>
      ) : null}
      {passages.length > 0 ? (
        <Section
          id="cx-sec-conv-passages"
          label={t("reader.quotedPassages", { n: passages.length })}
          right={
            <button type="button" class="cx-text-button" aria-expanded={passagesOpen} onClick={() => setPassagesOpen(!passagesOpen)}>
              {passagesOpen ? t("reader.showLess") : t("reader.showAll")}
            </button>
          }
        >
          {passagesOpen ? (
            <div class="cx-quotes">
              {passages.map((q) => (
                <QuoteRow speaker={q.speaker} quote={q.quote} date={q.date ? fmt.dateTime(Date.parse(q.date), true) : undefined} onOpen={() => openEntry(q.entryId)} />
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}
      {gist ? (
        <p class="cx-conv-caption">
          {t("reader.convNoteCaption")}{" "}
          {passages.length > 0 ? (
            <button type="button" class="cx-text-button" onClick={showPassages}>
              {t("reader.showSource")}
            </button>
          ) : null}
        </p>
      ) : null}
      <PinFocusText pinned={pinned} disabledPin={sandbox} onPin={togglePin} onShow={focusBrain} />
      {featureOn("corrections") ? (
        <CorrectBox
          comments={d.comments}
          disabled={!canFix}
          fmtDate={(ms) => fmt.date(ms, true)}
          onLooksRight={gist ? async () => void (await confirmNote(s, gist.id)) : undefined}
          onSave={async (text) => {
            const rec = await saveComment(s, gist?.id ?? c.id, text);
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

interface PlacedFix {
  correction: CorrectionRecord;
  text: string;
}

/** Your corrections, placed at the stem node whose message span contains their target (-1 = whole conversation). */
export function placeFixes(s: CortexServices, d: ConversationDetail, index: DataIndex | null, fmt: Fmt): Map<number, PlacedFix[]> {
  const out = new Map<number, PlacedFix[]>();
  for (const c of d.corrections) {
    if (c.undoes) continue;
    const text = fixLine(c, fmt);
    if (text === null) continue;
    let part = -1;
    const ordinal = c.target.startsWith("e_") ? resolveOrdinal(s, c.target, index) : -1;
    const idx = ordinal >= 0 ? metaOf(s, ordinal)?.conversation?.index : undefined;
    if (idx !== undefined) {
      const msg = idx + 1;
      part = d.parts.findIndex((x) => msg >= x.msgFrom && msg <= x.msgTo);
    } else {
      part = d.parts.findIndex((x) => x.notes.some((n) => n.id === c.target));
    }
    const list = out.get(part) ?? [];
    list.push({ correction: c, text });
    out.set(part, list);
  }
  return out;
}

function FixRow(p: { fix: PlacedFix; fmt: Fmt }): JSX.Element {
  return (
    <li class="cx-fix">
      <span class="cx-fix-icon" aria-hidden="true">
        ✎
      </span>
      <span class="cx-fix-label">{t("reader.yourFix")}</span>
      <span class="cx-fix-text">{p.fix.text}</span>
      <span class="cx-mono cx-note">{p.fmt.date(Date.parse(p.fix.correction.at), true)}</span>
    </li>
  );
}

function StemNode(p: { part: ConversationDetail["parts"][number]; hasGist: boolean; chips: readonly PartChip[]; fmt: Fmt; onOpenEntry(id: string): void; onOpenNote(n: NoteRecord): void }): JSX.Element {
  const part = p.part;
  const from = part.startedAt ? Date.parse(part.startedAt) : Number.NaN;
  const to = part.endedAt ? Date.parse(part.endedAt) : Number.NaN;
  const title = p.hasGist && part.title ? part.title : t("reader.partPlain", { n: part.n });
  const messages = t("reader.messagesSpan", { a: part.msgFrom, b: part.msgTo });
  const span = Number.isFinite(from) ? `${p.fmt.span(from, to)} · ${messages}` : messages;
  return (
    <li class="cx-stem-node">
      <span class="cx-stem-dot" aria-hidden="true" />
      <div class="cx-stem-head">
        <span class="cx-stem-title">{p.hasGist && part.title ? <SafeInline text={title} /> : title}</span>
        <span class="cx-mono cx-stem-span">{span}</span>
      </div>
      {p.chips.length > 0 ? (
        <div class="cx-part-chips" title={t("reader.partChipsNote")}>
          {p.chips.map((c) => (
            <span class="cx-chip is-machine" data-field={c.field}>
              {c.text}
            </span>
          ))}
        </div>
      ) : null}
      {stemNotes(part).length > 0 ? (
        <ul class="cx-stem-notes">
          {stemNotes(part).map((n) => (
            <NoteRow note={n} fmt={p.fmt} onOpenEntry={p.onOpenEntry} onOpenNote={p.onOpenNote} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function NoteRow(p: { note: NoteRecord; fmt: Fmt; onOpenEntry(id: string): void; onOpenNote(n: NoteRecord): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const n = p.note;
  return (
    <li class={`cx-note-row${open ? " is-open" : ""}`}>
      <div class="cx-note-row-head">
        <KindGlyph kind={n.kind} />
        <button type="button" class="cx-note-row-text" onClick={() => p.onOpenNote(n)}>
          <SafeInline text={n.text || n.title} />
        </button>
        <button type="button" class="cx-chevron" aria-expanded={open} aria-label={t("reader.quotes", { n: n.sources.length })} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </button>
      </div>
      {open ? (
        <div class="cx-quotes">
          {n.sources.map((q) => (
            <QuoteRow speaker={q.speaker} quote={q.quote} date={q.date ? p.fmt.dateTime(Date.parse(q.date), true) : undefined} onOpen={() => p.onOpenEntry(q.entryId)} />
          ))}
        </div>
      ) : null}
    </li>
  );
}
