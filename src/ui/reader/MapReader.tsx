/**
 * Map reader — a machine map of content (CORTEX-UX §5.16; ORIG-06). Code calls it a "hub". Owner: E12.
 *  - header: title, chip "‹n› sources", Flag, Pin, Show in brain (F), More (Open in editor, Copy link, Trace all
 *    sources); the parent map is the sheet's crumb;
 *  - kind line: ✦ + "Project map" / "Area map" / "Topic map", a 96 × 20 sparkline of member notes per week over
 *    the last 12 weeks and "last 12 weeks" — recency is read from the sparkline, there is no status sentence;
 *  - a brief of 3–5 bullets beside a dotted rule, each starting with an EVIDENCE METER (quotes from you over
 *    quotes from the assistant, computed by Cortex from the cited speakers: SAFE-09); a bullet expands to its
 *    quotes; a model chip "sonnet · refreshed 8 Nov";
 *  - kind filter chips, then members grouped by kind (≤ 3 rows per kind, then "+‹n› more"), rows expand to quotes;
 *  - footer "26 notes · 1,204 sources" and Trace all sources;
 *  - Flag: "What's wrong or missing in this map?" saved as a comment the next refresh must answer; open flags
 *    show waiting / answered with Resolve.
 * States: no members, refreshing (the current map stays), a failed refresh (Try again).
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { Population, type DataIndex } from "../../shared/index-format";
import type { CommentView, NoteDetail } from "../../plugin/services";
import { HUB_SECTION_KEYS, type Citation, type HubFields, type HubSectionKey, type HubStatement, type HubStatus, type NoteKind } from "../../shared/types";
import { addToken } from "../../state/actions";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { ChangeSlot, copyToClipboard, useChange, useFmt, useLoad, type Fmt } from "../pages/PageFrame";
import { IconButton } from "../primitives/buttons";
import { areaLabel, fmtInt, kindLabel, mapKindLabel } from "../valueLabels";
import { shortModel } from "./ConversationReader";
import { EvidenceMeter, KindGlyph, ModelChip, QuoteRow, Section, Sparkline } from "./marks";
import { idOf, isPinned, linkFor, metaOf, NotInIndex, openInObsidian, openReader, ReaderActions, ReaderLoad, resolveOrdinal, saveComment, setPinned, showInBrain, useIndex, type ReaderMoreItem } from "./readerKit";
import { SafeInline } from "./SafeMarkdown";

/** Evidence meter widths (0..1) for a bullet. */
export function evidenceMeter(you: number, assistant: number): { you: number; assistant: number } {
  const max = Math.max(1, you, assistant);
  return { you: you / max, assistant: assistant / max };
}

/** Quotes from you and from the assistant behind a statement, counted from the cited speakers (SAFE-09). */
export function evidenceFromCites(cites: readonly Pick<Citation, "speaker">[]): { you: number; assistant: number } {
  let you = 0;
  let assistant = 0;
  for (const c of cites) {
    if (c.speaker === "you") you++;
    else if (c.speaker === "assistant") assistant++;
  }
  return { you, assistant };
}

/** Distinct source entries cited by a set of notes (index relations), as ids. */
export function sourcesOf(index: DataIndex | null, noteOrdinals: readonly number[]): number[] {
  if (!index) return [];
  const seen = new Set<number>();
  const rel = index.rel.noteSources;
  for (const o of noteOrdinals) {
    if (o < 0 || o + 1 >= rel.offsets.length) continue;
    const a = rel.offsets[o] ?? 0;
    const b = rel.offsets[o + 1] ?? a;
    for (let i = a; i < b; i++) seen.add(rel.targets[i] as number);
  }
  return [...seen];
}

const STATUS_KEYS: Readonly<Record<HubStatus, "reader.mapStatusActive" | "reader.mapStatusQuiet" | "reader.mapStatusPaused">> = {
  active: "reader.mapStatusActive",
  quiet: "reader.mapStatusQuiet",
  paused: "reader.mapStatusPaused",
};

/** "active" · "quiet" · "paused". */
export function hubStatusWord(status: HubStatus): string {
  return t(STATUS_KEYS[status] ?? STATUS_KEYS.quiet);
}

const SECTION_KEYS: Readonly<Record<HubSectionKey, "reader.sectionNextSteps" | "reader.sectionOpenQuestions" | "reader.sectionKeyDecisions" | "reader.sectionWhatItIs" | "reader.sectionWhereItStands" | "reader.sectionWhatWasFound">> = {
  nextSteps: "reader.sectionNextSteps",
  openQuestions: "reader.sectionOpenQuestions",
  keyDecisions: "reader.sectionKeyDecisions",
  whatItIs: "reader.sectionWhatItIs",
  whereItStands: "reader.sectionWhereItStands",
  whatWasFound: "reader.sectionWhatWasFound",
};

/** The typed sections a map has, in its type's reading order; a section with no statements is left out (SPEC V13). */
export function hubSections(hub: Pick<HubFields, "hubType" | "sections">): { key: HubSectionKey; label: string; items: readonly HubStatement[] }[] {
  const out: { key: HubSectionKey; label: string; items: readonly HubStatement[] }[] = [];
  for (const key of HUB_SECTION_KEYS[hub.hubType] ?? []) {
    const items = hub.sections?.[key];
    if (items && items.length > 0) out.push({ key, label: t(SECTION_KEYS[key]), items });
  }
  return out;
}

/** Whole days between a map's newest activity and the person's most recent entry (never negative); null when either is unknown. */
export function daysBeforeNewest(lastActivityMs: number, newestEntryMs: number): number | null {
  if (!Number.isFinite(lastActivityMs) || !Number.isFinite(newestEntryMs)) return null;
  return Math.max(0, Math.round((newestEntryMs - lastActivityMs) / 86_400_000));
}

const newestCache = new WeakMap<DataIndex, number>();

/** Time of the person's most recent entry (record items only; NaN when none is dated). */
export function newestEntryOf(index: DataIndex | null): number {
  if (!index) return Number.NaN;
  let v = newestCache.get(index);
  if (v === undefined) {
    v = Number.NEGATIVE_INFINITY;
    const { t, pop } = index.cols;
    for (let o = 0; o < index.count; o++) {
      const x = t[o] as number;
      if (pop[o] === Population.Record && Number.isFinite(x) && x > v) v = x;
    }
    if (v === Number.NEGATIVE_INFINITY) v = Number.NaN;
    newestCache.set(index, v);
  }
  return v;
}

/** The project map's status sentence, or null when the dates are unknown. */
export function statusSentence(status: HubStatus, lastActivityMs: number, newestEntryMs: number): string | null {
  const days = daysBeforeNewest(lastActivityMs, newestEntryMs);
  if (days === null) return null;
  const word = hubStatusWord(status);
  return days === 0 ? t("reader.mapStatusLineToday", { status: word }) : t("reader.mapStatusLine", { status: word, n: fmtInt(days) });
}

const KIND_ORDER: readonly NoteKind[] = ["decision", "question", "plan", "idea", "abandoned", "concept", "gist", "wiki", "reference", "log", "hub"];

export function MapReader(p: { id: string }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const ordinal = resolveOrdinal(s, p.id, index);
  const [nonce, setNonce] = useState(0);
  const detail = useLoad(async () => {
    if (ordinal < 0) throw new NotInIndex(index === null);
    return s.records.note(ordinal);
  }, [p.id, ordinal, nonce]);
  return <ReaderLoad value={detail}>{(d) => <MapView id={p.id} ordinal={ordinal} detail={d} reload={() => setNonce((n) => n + 1)} />}</ReaderLoad>;
}

export function MapView(p: { id: string; ordinal: number; detail: NoteDetail; reload(): void }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const index = useIndex(s);
  const change = useChange();
  const n = p.detail.record;
  const hub = n.hub;
  const sandbox = s.sandbox.value;
  const canFix = featureOn("corrections") && !sandbox;
  const [status, setStatus] = useState<string | null>(null);
  const [flagOpen, setFlagOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState<NoteKind | "all">("all");
  const [pinned, setPinnedState] = useState(() => isPinned(s, n.id, p.ordinal, index));
  const members = p.detail.members ?? [];
  const memberOrdinals = members.flatMap((g) => g.ids.map((id) => resolveOrdinal(s, id, index))).filter((o) => o >= 0);
  const sources = sourcesOf(index, memberOrdinals);
  const totalMembers = members.reduce((a, g) => a + g.count, 0);
  const madeBy = "legacy" in n.madeBy ? null : n.madeBy;
  const refreshing = n.state === "stale" && s.shared.slices.activity.value.jobs.some((j) => j.kind === "hub");
  const lastRun = useLoad(async () => {
    if (sandbox) return null; // the sample record has no runs, and never reads the real ledger
    const runs = await s.ledger.runs({ job: "hub", limit: 50 });
    return runs.filter((r) => r.targets.includes(n.id)).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null;
  }, [n.id]);
  const failed = lastRun.state === "ready" && lastRun.value?.status === "failed" ? lastRun.value : null;

  const traceAll = () => {
    const ids = sources.map((o) => idOf(s, o, index)).filter((x): x is string => x !== undefined);
    if (ids.length > 0) addToken(leaf.store, { id: `set:map:${n.id}`, kind: "set", label: t("reader.sourcesToken", { title: n.title }), ids });
  };
  const togglePin = () => {
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
  };
  const focusBrain = () => showInBrain(s, leaf, p.ordinal, n.id);
  const more: ReaderMoreItem[] = [
    ...(n.file ? [{ value: "editor", label: t("reader.openInEditor"), run: () => (openInObsidian(s.app, n.file, "tab") ? undefined : setStatus(t("reader.openFailed"))) }] : []),
    { value: "link", label: t("reader.copyLink"), run: () => void copyToClipboard(linkFor({ note: n.file })).then((ok) => setStatus(ok ? t("reader.copied") : t("errors.action"))) },
    { value: "trace", label: t("reader.traceAll"), disabled: sources.length === 0, run: traceAll },
  ];
  const parentId = hub?.within;
  const parentOrdinal = parentId ? resolveOrdinal(s, parentId, index) : -1;
  const parentTitle = parentId ? (metaOf(s, parentOrdinal)?.title ?? "") : "";
  const areaName = n.space && n.space !== "none" ? areaLabel(n.space) : "";
  const rangeFrom = hub ? Date.parse(hub.range[0]) : Number.NaN;
  const rangeTo = hub ? Date.parse(hub.range[1]) : Number.NaN;
  const rangeText = Number.isFinite(rangeFrom) && Number.isFinite(rangeTo) ? t("reader.mapRange", { from: fmt.date(rangeFrom), to: fmt.date(rangeTo) }) : "";
  const sections = hub ? hubSections(hub) : [];
  const newestEntryMs = newestEntryOf(index);
  const statusLine = hub && hub.hubType === "project" ? statusSentence(hub.status, Date.parse(hub.range[1]), newestEntryMs) : null;
  const kinds = [...members].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).filter((g) => g.count > 0);

  return (
    <article class="cx-reader cx-map-reader" data-id={n.id}>
      <div class="cx-reader-head">
        <h3 class="cx-reader-title">{n.title}</h3>
        {featureOn("corrections") ? (
          <button type="button" class="cx-text-button cx-map-flag" aria-pressed={flagOpen} disabled={!canFix} onClick={() => setFlagOpen(!flagOpen)}>
            {t("reader.flag")}
          </button>
        ) : null}
        <span class="cx-chip">{t("reader.sourcesChip", { n: fmtInt(sources.length) })}</span>
        <ReaderActions
          extra={
            <span class="cx-map-icons">
              {featureOn("corrections") ? <IconButton icon="flag" label={t("reader.flag")} pressed={flagOpen} onClick={() => (canFix ? setFlagOpen(!flagOpen) : undefined)} /> : null}
              <IconButton icon="pin" label={pinned ? t("reader.unpin") : t("reader.pin")} pressed={pinned} onClick={() => (sandbox ? undefined : togglePin())} />
              {p.ordinal >= 0 ? <IconButton icon="showInBrain" label={`${t("reader.showInBrain")} (F)`} onClick={focusBrain} /> : null}
            </span>
          }
          more={more}
        />
      </div>
      <ChangeSlot state={change} />
      {status ? (
        <p class="cx-note" role="status">
          {status}
        </p>
      ) : null}
      {flagOpen ? (
        <FlagBox
          onCancel={() => setFlagOpen(false)}
          onSave={async (text) => {
            const rec = await saveComment(s, n.id, text, "map-flag");
            setFlagOpen(false);
            change.post(t("toasts.flagSaved"), async () => {
              await s.corrections.undo(rec.id, "map-flag");
              p.reload();
            });
            p.reload();
          }}
        />
      ) : null}
      <Flags
        comments={p.detail.comments}
        fmt={fmt}
        canFix={canFix}
        onResolve={async (c) => {
          if (c.state === "answered" && madeBy) await s.corrections.apply({ via: "map-flag", action: "resolve-comment", target: n.id, payload: { commentId: c.id as `k_${string}`, runId: madeBy.runId } });
          else await s.corrections.undo(c.id as `k_${string}`, "map-flag");
          p.reload();
        }}
      />
      {refreshing ? (
        <div class="cx-progress-line" role="status">
          <span class="cx-progress-bar" aria-hidden="true" />
          <span class="cx-note">{t("reader.mapRefreshing", { model: shortModel(s.settings.value.agents.models.maps) })}</span>
        </div>
      ) : null}
      {failed && !refreshing ? (
        <div class="cx-banner-card" role="status">
          <p>{t("reader.mapFailed", { date: fmt.date(Date.parse(failed.startedAt), true) })}</p>
          <button
            type="button"
            class="cx-button"
            disabled={sandbox}
            onClick={() =>
              void s.runner
                .request({ cmd: "agents.enqueue", args: { jobs: ["hub"], targets: [n.id], reason: "manual" } })
                .then(() => setStatus(t("reader.refreshing", { model: shortModel(s.settings.value.agents.models.maps) })))
                .catch(() => setStatus(t("errors.action")))
            }
          >
            {t("app.retry")}
          </button>
        </div>
      ) : null}

      <div class="cx-kind-line">
        <KindGlyph kind="map" />
        <span>{hub ? mapKindLabel(hub.hubType) : kindLabel("map")}</span>
        {hub ? <span class="cx-map-status" data-status={hub.status}>{hubStatusWord(hub.status)}</span> : null}
        {rangeText ? <span class="cx-map-range">{rangeText}</span> : null}
        {p.detail.activity && p.detail.activity.length > 0 ? <Sparkline values={p.detail.activity} label={t("reader.sparkline")} /> : null}
        <span class="cx-mono cx-note">{t("reader.activity")}</span>
      </div>
      <p class="cx-map-caption">{t("reader.mapCaption")}</p>
      <p class="cx-map-source-link">
        <button type="button" class="cx-text-button" disabled={sources.length === 0} onClick={traceAll}>
          {t("reader.showSource")}
        </button>
      </p>
      {parentId && parentTitle ? (
        <p class="cx-map-within">
          <button type="button" class="cx-text-button" onClick={() => openReader(leaf, "map", parentId, parentOrdinal)}>
            {t("reader.within", { area: parentTitle })}
          </button>
        </p>
      ) : areaName ? (
        <p class="cx-map-within">{t("reader.within", { area: areaName })}</p>
      ) : null}
      {statusLine ? <p class="cx-note cx-map-status-line">{statusLine}</p> : null}

      {hub && hub.brief.length > 0 ? (
        <div class="cx-brief cx-machine-rule">
          <ul>
            {hub.brief.map((b, i) => (
              <BriefBullet text={b.text} cites={b.cites} evidence={p.detail.evidence?.[i] ?? evidenceFromCites(b.cites)} fmt={fmt} onOpen={(id) => openReader(leaf, "entry", id, resolveOrdinal(s, id, index))} />
            ))}
          </ul>
          {madeBy ? <ModelChip>{t("reader.refreshedOn", { model: shortModel(madeBy.model), date: fmt.date(Date.parse(madeBy.at), true) })}</ModelChip> : null}
        </div>
      ) : null}

      {sections.map((sec) => (
        <Section label={sec.label} class={`cx-hub-section is-${sec.key}`}>
          <div class="cx-brief cx-machine-rule">
            <ul>
              {sec.items.map((b) => (
                <BriefBullet text={b.text} cites={b.cites} evidence={evidenceFromCites(b.cites)} fmt={fmt} onOpen={(id) => openReader(leaf, "entry", id, resolveOrdinal(s, id, index))} />
              ))}
            </ul>
          </div>
        </Section>
      ))}

      {totalMembers === 0 ? (
        <p class="cx-note">{t("reader.noMembers")}</p>
      ) : (
        <>
          <div class="cx-chip-row" role="radiogroup" aria-label={t("reader.labels")}>
            <button type="button" role="radio" aria-checked={kindFilter === "all"} class={`cx-term${kindFilter === "all" ? " is-on" : ""}`} onClick={() => setKindFilter("all")}>
              {t("reader.allKinds", { n: totalMembers })}
            </button>
            {kinds.map((g) => (
              <button type="button" role="radio" aria-checked={kindFilter === g.kind} class={`cx-term${kindFilter === g.kind ? " is-on" : ""}`} onClick={() => setKindFilter(g.kind)}>
                {t("reader.kindCount", { kind: kindLabel(g.kind, true), n: g.count })}
              </button>
            ))}
          </div>
          {kinds
            .filter((g) => kindFilter === "all" || g.kind === kindFilter)
            .map((g) => (
              <MemberGroup kind={g.kind} count={g.count} ids={g.ids} expanded={kindFilter === g.kind} fmt={fmt} />
            ))}
        </>
      )}

      <div class="cx-map-text-actions">
        <button type="button" class="cx-text-button" aria-pressed={pinned} disabled={sandbox} onClick={togglePin}>
          {pinned ? t("reader.unpin") : t("reader.pin")}
        </button>
        {p.ordinal >= 0 ? (
          <button type="button" class="cx-text-button" onClick={focusBrain}>
            {t("reader.focusInBrain")}
          </button>
        ) : null}
      </div>

      <div class="cx-reader-foot">
        <span class="cx-mono cx-note">{t("reader.membersLine", { notes: fmtInt(totalMembers), sources: fmtInt(sources.length) })}</span>
        <button type="button" class="cx-text-button" disabled={sources.length === 0} onClick={traceAll}>
          {t("reader.traceAll")}
        </button>
      </div>
    </article>
  );
}

/** Quotes shown open under a statement before "+n more". */
export const OPEN_QUOTES = 2;

function BriefBullet(p: { text: string; cites: readonly Citation[]; evidence: { you: number; assistant: number }; fmt: Fmt; onOpen(id: string): void }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const [collapsed, setCollapsed] = useState(false);
  const [all, setAll] = useState(false);
  const first = p.cites[0];
  const sourceTitle = first ? (metaOf(s, resolveOrdinal(s, first.entryId, index))?.title ?? "") : "";
  const shown = all ? p.cites : p.cites.slice(0, OPEN_QUOTES);
  const rest = p.cites.length - shown.length;
  return (
    <li class="cx-brief-item">
      <button type="button" class="cx-brief-head" aria-expanded={!collapsed && p.cites.length > 0} onClick={() => setCollapsed(!collapsed)}>
        <EvidenceMeter you={p.evidence.you} assistant={p.evidence.assistant} />
        <span class="cx-brief-body">
          <span class="cx-brief-text">
            <SafeInline text={p.text} />
          </span>
          {sourceTitle ? <span class="cx-brief-source">{sourceTitle}</span> : null}
        </span>
      </button>
      {!collapsed && shown.length > 0 ? (
        <div class="cx-quotes">
          {shown.map((c) => (
            <QuoteRow named speaker={c.speaker} quote={c.quote} date={c.date ? p.fmt.dateTime(Date.parse(c.date), true) : undefined} onOpen={() => p.onOpen(c.entryId)} />
          ))}
          {rest > 0 ? (
            <button type="button" class="cx-text-button cx-brief-more" onClick={() => setAll(true)}>
              {t("reader.moreMembers", { n: rest })}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function MemberGroup(p: { kind: NoteKind; count: number; ids: readonly string[]; expanded: boolean; fmt: Fmt }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const [all, setAll] = useState(p.expanded);
  const shown = all ? p.ids : p.ids.slice(0, 3);
  const rest = p.ids.length - shown.length;
  return (
    <Section label={<>{kindLabel(p.kind, true)}</>} right={<span class="cx-mono">{p.count}</span>} class="cx-members">
      <ul class="cx-member-rows">
        {shown.map((id) => (
          <MemberRow id={id} ordinal={resolveOrdinal(s, id, index)} kind={p.kind} fmt={p.fmt} />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" class="cx-text-button" onClick={() => setAll(true)}>
          {t("reader.moreMembers", { n: rest })}
        </button>
      ) : null}
    </Section>
  );
}

function MemberRow(p: { id: string; ordinal: number; kind: NoteKind; fmt: Fmt }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  const [open, setOpen] = useState(false);
  const meta = metaOf(s, p.ordinal);
  const quotes = useLoad(async () => (open && p.ordinal >= 0 ? (await s.records.note(p.ordinal)).cites : []), [open, p.ordinal]);
  const date = meta?.writtenAt ? p.fmt.date(Date.parse(meta.writtenAt), true) : "";
  return (
    <li class="cx-member-row">
      <div class="cx-member-head">
        <KindGlyph kind={p.kind} />
        <button type="button" class="cx-member-text" onClick={() => openReader(leaf, p.kind === "hub" ? "map" : p.kind === "gist" ? "conversation" : "note", p.id, p.ordinal)}>
          {meta ? meta.title : p.id}
        </button>
        <span class="cx-mono cx-note">{date}</span>
        <button type="button" class="cx-chevron" aria-expanded={open} aria-label={t("reader.showQuotes")} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </button>
      </div>
      {open ? (
        quotes.state === "ready" ? (
          <div class="cx-quotes">
            {quotes.value.map((c) => (
              <QuoteRow speaker={c.speaker} quote={c.quote} valid={c.valid} date={c.date ? p.fmt.dateTime(Date.parse(c.date), true) : undefined} onOpen={() => openReader(leaf, "entry", c.entryId, resolveOrdinal(s, c.entryId, index))} />
            ))}
          </div>
        ) : quotes.state === "error" ? (
          <p class="cx-note">{t("errors.reader")}</p>
        ) : (
          <p class="cx-note">{t("reader.loadingMore")}</p>
        )
      ) : null}
    </li>
  );
}

function FlagBox(p: { onSave(text: string): Promise<void>; onCancel(): void }): JSX.Element {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const save = async () => {
    if (!text.trim()) return;
    setState("saving");
    try {
      await p.onSave(text.trim());
    } catch {
      setState("failed");
    }
  };
  return (
    <div class="cx-flag-box">
      <textarea
        class="cx-textarea is-short"
        rows={3}
        placeholder={t("reader.flagPrompt")}
        aria-label={t("reader.flagPrompt")}
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            p.onCancel();
          }
        }}
      />
      <div class="cx-row-buttons">
        <button type="button" class="cx-button is-primary" disabled={state === "saving" || !text.trim()} onClick={() => void save()}>
          {state === "saving" ? t("dialogs.saving") : t("reader.save")}
        </button>
        <button type="button" class="cx-button" onClick={p.onCancel}>
          {t("reader.cancel")}
        </button>
      </div>
      {state === "failed" ? (
        <p class="cx-note is-error" role="alert">
          {t("dialogs.failed")}
        </p>
      ) : null}
    </div>
  );
}

function Flags(p: { comments: readonly CommentView[]; fmt: Fmt; canFix: boolean; onResolve(c: CommentView): Promise<void> }): JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  if (p.comments.length === 0) return null;
  return (
    <Section label={t("reader.flagged")}>
      <ul class="cx-comments">
        {p.comments.map((c) => (
          <li class={`cx-comment is-${c.state}`}>
            <span class="cx-comment-text">{c.text}</span>
            <span class="cx-comment-state cx-mono">{c.state === "answered" && c.answeredAt ? t("reader.answered", { date: p.fmt.date(Date.parse(c.answeredAt), true) }) : t("reader.waitingRefresh")}</span>
            {p.canFix ? (
              <button
                type="button"
                class="cx-text-button"
                disabled={busy === c.id}
                onClick={() => {
                  setBusy(c.id);
                  p.onResolve(c).finally(() => setBusy(null));
                }}
              >
                {t("reader.resolve")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Member notes of a map by kind, for tests and the stage's member card. */
export function memberKinds(members: NoteDetail["members"]): { kind: NoteKind; count: number }[] {
  return [...(members ?? [])].filter((g) => g.count > 0).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).map((g) => ({ kind: g.kind, count: g.count }));
}

