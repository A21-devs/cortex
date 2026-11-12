/**
 * Checks, a tab of Agents (CORTEX-UX §5.21, §12.9, P1): confirm or correct what the agents decided; your answer
 * always wins. Owner: E12 (cards) with E6 (cards come from label, summary, filing, name-check and conflict runs).
 * Progress "‹n› checked today · ‹m› waiting" + filter chips All · Labels · Summaries · Filing · Mentions ·
 * Conflicts · Unsure (confidence < 0.6). Card: context line, title, an excerpt of your words (solid rule, ≤ 6
 * lines), the proposal (dotted rule) "session 1.0.0 suggests" with one row per field and the confidence in mono,
 * a model chip, Why? → "The AI's reason". Buttons Confirm (1) · Change (2) · Reject (3, reason chips) · Skip (4).
 * Filing is applied only if confirmed; mentions: That's me · Not me · Skip; conflicts: side-by-side diff, Keep
 * mine · Use theirs. The next card slides in (260 ms) with an Undo change toast. Keys 1–4, J/K, Z.
 * With After labelling = Hold for my check, labels wait (LabelRecord.state "held") and count nowhere.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ConflictCardProposal, FilingCardProposal, LabelCardProposal, MentionCardProposal, NoteCardProposal } from "../../agents/schemas";
import type { CheckAnswer } from "../../plugin/corrections";
import { cleanDirection, type DirectionCardProposal } from "../../shared/directions";
import type { ReviewCardRecord } from "../../shared/types";
import { useServices } from "../context";
import { t } from "../copy";
import { Button } from "../primitives/buttons";
import { ModelChip } from "../reader/marks";
import { labelValueText, metaOf, resolveOrdinal, useIndex } from "../reader/readerKit";
import { SafeInline } from "../reader/SafeMarkdown";
import { areaLabel, fmtPercent, isoMs, kindLabel, sourceLabel } from "../valueLabels";
import { cardGiven } from "./Directions";
import { ResumeClaims } from "./ResumeClaims";
import { ChangeSlot, ErrorCard, isTypingTarget, Load, Skeleton, useChange, useFmt, useLoad } from "./PageFrame";

export type CheckFilter = "all" | "labels" | "summaries" | "filing" | "mentions" | "conflicts" | "directions" | "unsure";
export const CHECK_FILTERS: readonly CheckFilter[] = ["all", "labels", "summaries", "filing", "mentions", "conflicts", "directions", "unsure"];
/** Below this confidence a card counts as Unsure. */
export const UNSURE_BELOW = 0.6;
/** Confirm all asks once, inline, before writing when more than this many checks are waiting. */
export const CONFIRM_ALL_ASK_ABOVE = 25;

/** The checks a bulk Confirm covers: labels, summaries, filing and directions. A mention or a conflict needs your own answer. */
export function bulkConfirmable<T extends { id: string; kind: ReviewCardRecord["kind"] }>(cards: readonly T[], skipped: ReadonlySet<string> = new Set()): T[] {
  return cards.filter((c) => (c.kind === "label" || c.kind === "note" || c.kind === "filing" || c.kind === "direction") && !skipped.has(c.id));
}

/**
 * Confirm every given check in one batched append and return how to take it back: Undo reverses exactly that batch
 * through the corrections log. `left` are cards that were gone, already answered or not confirmable in bulk.
 */
export async function confirmAllChecks(corrections: Pick<import("../../plugin/corrections").CorrectionService, "confirmChecks" | "undoMany">, cardIds: readonly string[]): Promise<{ confirmed: number; left: number; undo: (() => Promise<void>) | undefined }> {
  const done = await corrections.confirmChecks(cardIds);
  const undo = done.ids.length > 0 ? async () => void (await corrections.undoMany(done.ids, "checks")) : undefined;
  return { confirmed: done.confirmed.length, left: done.left.length, undo };
}

const FILTER_KIND: Readonly<Record<CheckFilter, ReviewCardRecord["kind"] | "unsure" | undefined>> = { all: undefined, labels: "label", summaries: "note", filing: "filing", mentions: "mention", conflicts: "conflict", directions: "direction", unsure: "unsure" };
const FILTER_LABEL: Readonly<Record<CheckFilter, "checks.all" | "checks.labels" | "checks.summaries" | "checks.filing" | "checks.mentions" | "checks.conflicts" | "checks.directions" | "checks.unsure">> = {
  all: "checks.all",
  labels: "checks.labels",
  summaries: "checks.summaries",
  filing: "checks.filing",
  mentions: "checks.mentions",
  conflicts: "checks.conflicts",
  directions: "checks.directions",
  unsure: "checks.unsure",
};

/** Keyboard answers on a label or note card: 1 Confirm · 2 Change (opens pickers) · 3 Reject (reason chips) · 4 Skip. */
export function keyToAnswer(key: string): CheckAnswer["kind"] | "open-change" | "open-reject" | "next" | "previous" | "undo" | null {
  switch (key) {
    case "1":
      return "confirm";
    case "2":
      return "open-change";
    case "3":
      return "open-reject";
    case "4":
      return "skip";
    case "j":
    case "J":
      return "next";
    case "k":
    case "K":
      return "previous";
    case "z":
    case "Z":
      return "undo";
    default:
      return null;
  }
}

/** Whether a card counts as Unsure (a stated confidence under 0.6). */
export function isUnsure(card: Pick<ReviewCardRecord, "confidence">): boolean {
  return typeof card.confidence === "number" && card.confidence < UNSURE_BELOW;
}

/** The sentence for an answer, for "Answered · confirmed". */
export function answerText(a: CheckAnswer): string {
  switch (a.kind) {
    case "confirm":
      return t("checks.answerConfirm");
    case "change":
      return t("checks.answerChange");
    case "reject":
      return t("checks.answerReject");
    case "skip":
      return t("checks.answerSkip");
    case "mention":
      return a.mine ? t("checks.answerMine") : t("checks.answerNotMine");
    default:
      return a.keep === "mine" ? t("checks.answerKeep") : t("checks.answerTheirs");
  }
}

/** The sentence for an answer to a direction card: accepted, edited and accepted, or dismissed. */
export function directionAnswerText(a: CheckAnswer): string {
  return a.kind === "confirm" ? t("checks.answerAccepted") : a.kind === "change" ? t("checks.answerEdited") : a.kind === "reject" ? t("checks.answerDismissed") : answerText(a);
}

const REASONS: readonly { reason: Extract<CheckAnswer, { kind: "reject" }>["reason"]; label: "checks.wrong" | "checks.notAbout" | "checks.vague" | "checks.otherReason" }[] = [
  { reason: "wrong", label: "checks.wrong" },
  { reason: "not-about-this", label: "checks.notAbout" },
  { reason: "too-vague", label: "checks.vague" },
  { reason: "other", label: "checks.otherReason" },
];

export function Checks(p: { initial?: string } = {}): JSX.Element {
  const s = useServices();
  const change = useChange();
  const [filter, setFilter] = useState<CheckFilter>(() => CHECK_FILTERS.find((f) => f === p.initial) ?? "all");
  const [at, setAt] = useState(0);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"view" | "change" | "reject">("view");
  const root = useRef<HTMLElement>(null);
  const progress = useLoad(() => s.ledger.checksToday(), [nonce]);
  const cards = useLoad(() => s.ledger.checks({ kind: FILTER_KIND[filter], limit: 200 }), [filter, nonce]);
  const bulk = useLoad(() => s.ledger.checks({ kind: FILTER_KIND[filter], limit: 5000 }), [filter, nonce]);
  const [asking, setAsking] = useState(false);
  const hold = s.settings.value.agents.reviewMode === "hold";

  const list = (cards.state === "ready" ? cards.value : cards.state === "loading" ? cards.previous ?? [] : []).filter((c) => !skipped.has(c.id));
  const index = Math.min(at, Math.max(0, list.length - 1));
  const card = list[index];

  const answer = async (a: CheckAnswer) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      const rec = await s.corrections.resolveCheck(card.id, a);
      setMode("view");
      if (a.kind === "skip") setSkipped((cur) => new Set(cur).add(card.id));
      else {
        const undo = rec
          ? async () => {
              await s.corrections.undo(rec.id, "checks");
              setNonce((n) => n + 1);
            }
          : undefined;
        change.post(t("checks.answered", { answer: card.kind === "direction" ? directionAnswerText(a) : answerText(a) }), undo);
        setNonce((n) => n + 1);
      }
    } catch {
      change.post(t("errors.action"));
    } finally {
      setBusy(false);
    }
  };

  const bulkCards = bulk.state === "ready" ? bulkConfirmable(bulk.value, skipped) : bulk.state === "loading" ? bulkConfirmable(bulk.previous ?? [], skipped) : [];

  const confirmAll = async () => {
    if (busy || bulkCards.length === 0) return;
    setAsking(false);
    setBusy(true);
    try {
      const r = await confirmAllChecks(s.corrections, bulkCards.map((c) => c.id));
      const undo = r.undo
        ? async () => {
            await r.undo?.();
            s.shared.update("queues", (q) => ({ ...q, checks: q.checks + r.confirmed }));
            setNonce((n) => n + 1);
          }
        : undefined;
      change.post(t(r.left > 0 ? "checks.confirmedAllLeft" : "checks.confirmedAll", { n: r.confirmed.toLocaleString("en-GB"), m: r.left.toLocaleString("en-GB") }), undo);
      // The rail's Checks meter drops now; the next status read confirms it.
      s.shared.update("queues", (q) => ({ ...q, checks: Math.max(0, q.checks - r.confirmed) }));
      setNonce((n) => n + 1);
    } catch (e) {
      change.post(e instanceof Error && e.message === t("checks.sample") ? t("checks.sample") : t("errors.action"));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = keyToAnswer(e.key);
    if (!k) return;
    e.preventDefault();
    if (k === "next") setAt(Math.min(list.length - 1, index + 1));
    else if (k === "previous") setAt(Math.max(0, index - 1));
    else if (k === "undo") {
      const last = change.change;
      if (last?.undo && last.state === "applied") {
        change.set({ ...last, state: "undoing" });
        void last.undo().then(
          () => change.set({ ...last, state: "undone" }),
          () => change.set({ ...last, state: "failed" }),
        );
      }
    }
    else if (!card) return;
    else if (k === "open-change") setMode("change");
    else if (k === "open-reject") setMode("reject");
    else if (k === "skip") void answer({ kind: "skip" });
    else if (k === "confirm" && (card.kind === "label" || card.kind === "note" || card.kind === "filing" || card.kind === "direction")) void answer({ kind: "confirm" });
  };

  useEffect(() => {
    setMode("view");
  }, [card?.id]);
  useEffect(() => setAsking(false), [filter]);

  const checked = progress.state === "ready" ? progress.value.checked : 0;
  const waiting = progress.state === "ready" ? progress.value.waiting : list.length;

  return (
    <section class="cx-checks" aria-label={t("agents.checks")} ref={root} tabIndex={-1} onKeyDown={onKey}>
      <p class="cx-checks-progress cx-mono">{t("checks.progress", { n: checked.toLocaleString("en-GB"), m: waiting.toLocaleString("en-GB") })}</p>
      <ResumeClaims />
      {hold ? <p class="cx-note">{t("checks.hold")}</p> : null}
      <div class="cx-checks-bulk">
        {asking ? (
          <>
            <span class="cx-note" role="alert">
              {t("checks.confirmAllAsk", { n: bulkCards.length.toLocaleString("en-GB") })}
            </span>
            <Button primary disabled={busy} onClick={() => void confirmAll()}>
              {t("checks.confirmAllYes", { n: bulkCards.length.toLocaleString("en-GB") })}
            </Button>
            <button type="button" class="cx-text-button" onClick={() => setAsking(false)}>
              {t("checks.confirmAllCancel")}
            </button>
          </>
        ) : (
          <Button disabled={busy || bulkCards.length === 0} title={bulkCards.length === 0 ? t("checks.confirmAllNone") : t("checks.confirmAllHint")} onClick={() => (bulkCards.length > CONFIRM_ALL_ASK_ABOVE ? setAsking(true) : void confirmAll())}>
            {t("checks.confirmAll", { n: bulkCards.length.toLocaleString("en-GB") })}
          </Button>
        )}
      </div>
      <div class="cx-chip-row" role="radiogroup" aria-label={t("agents.checks")}>
        {CHECK_FILTERS.map((f) => (
          <button type="button" role="radio" aria-checked={filter === f} class={`cx-filter-chip${filter === f ? " is-on" : ""}`} onClick={() => (setFilter(f), setAt(0))}>
            {t(FILTER_LABEL[f])}
          </button>
        ))}
      </div>
      <Load value={cards} failed={t("errors.checks")} rows={5}>
        {() =>
          !card ? (
            <p class="cx-note">{checked > 0 ? t("checks.done", { n: checked.toLocaleString("en-GB") }) : t("checks.empty")}</p>
          ) : (
            <>
              <CheckCard key={card.id} card={card} busy={busy} mode={mode} setMode={setMode} onAnswer={(a) => void answer(a)} />
              <nav class="cx-checks-nav" aria-label={t("checks.position", { i: index + 1, n: list.length })}>
                <button type="button" class="cx-text-button" disabled={index === 0} onClick={() => setAt(index - 1)}>
                  {t("checks.previous")}
                </button>
                <span class="cx-mono cx-note">{t("checks.position", { i: index + 1, n: list.length })}</span>
                <button type="button" class="cx-text-button" disabled={index >= list.length - 1} onClick={() => setAt(index + 1)}>
                  {t("checks.next")}
                </button>
              </nav>
              <p class="cx-note cx-checks-keys">{card.kind === "direction" ? t("checks.directionKeys") : t("checks.keys")}</p>
            </>
          )
        }
      </Load>
      <ChangeSlot state={change} />
    </section>
  );
}

function CheckCard(p: { card: ReviewCardRecord; busy: boolean; mode: "view" | "change" | "reject"; setMode(m: "view" | "change" | "reject"): void; onAnswer(a: CheckAnswer): void }): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const index = useIndex(s);
  const c = p.card;
  const proposal = c.proposal as { kind?: string } | null;
  const [why, setWhy] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const target = c.kind === "direction" ? { title: t("checks.directions"), source: cardGiven(c.proposal as DirectionCardProposal) } : describeTarget(s, index, c.target);
  const context = t("checks.context", { kind: cardKindLabel(c.kind), source: target.source ?? t("agents.none"), date: fmt.date(isoMs(c.createdAt), true) });
  const excerpt = useLoad(async () => {
    if (!target.convId || (c.kind !== "label" && c.kind !== "filing")) return null;
    const slice = await s.records.conversationSlice(target.convId, 0, 8);
    const mine = slice.find((m) => m.speaker === "you" && m.text.ok);
    return mine && mine.text.ok ? mine.text.text : null;
  }, [c.id]);
  const confidence = typeof c.confidence === "number" ? fmtPercent(c.confidence) : null;
  const disabled = p.busy;

  let body: JSX.Element;
  let buttons: JSX.Element;
  switch (proposal?.kind) {
    case "label": {
      const pr = c.proposal as LabelCardProposal;
      body = (
        <>
          <Excerpt value={excerpt} />
          <div class="cx-proposal">
            <p class="cx-proposal-head">
              {t("checks.suggests", { pack: pr.pack, version: pr.version })} {c.model ? <ModelChip>{c.model}</ModelChip> : null}
            </p>
            <ul>
              {pr.fields.map((f) => (
                <li>
                  {p.mode === "change" ? (
                    <label class="cx-field">
                      <span>{f.field}</span>
                      <input class="cx-input" type="text" value={edit[f.field] ?? labelValueText(f.value)} onInput={(e) => setEdit({ ...edit, [f.field]: (e.currentTarget as HTMLInputElement).value })} />
                    </label>
                  ) : (
                    <>
                      <span>{t("checks.fieldValue", { field: f.field, value: labelValueText(f.value) })}</span>
                      {typeof f.confidence === "number" ? <span class="cx-mono cx-note"> {fmtPercent(f.confidence)}</span> : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      );
      buttons = <StandardButtons {...p} onSave={() => p.onAnswer({ kind: "change", values: Object.fromEntries(Object.entries(edit).filter(([k]) => pr.fields.some((f) => f.field === k))) })} disabled={disabled} />;
      break;
    }
    case "note": {
      const pr = c.proposal as NoteCardProposal;
      body = (
        <div class="cx-proposal">
          <p class="cx-proposal-head">
            {t("checks.noteSuggests", { model: c.model ?? "" })} {c.model ? <ModelChip>{c.model}</ModelChip> : null}
          </p>
          <p class="cx-proposal-title">{pr.title}</p>
          <SafeInline text={pr.text} />
          {p.mode === "change" ? <textarea class="cx-textarea" aria-label={t("checks.otherNote")} placeholder={t("checks.otherNote")} value={edit.comment ?? ""} onInput={(e) => setEdit({ ...edit, comment: (e.currentTarget as HTMLTextAreaElement).value })} /> : null}
        </div>
      );
      buttons = <StandardButtons {...p} onSave={() => p.onAnswer({ kind: "change", values: { comment: edit.comment ?? "" } })} disabled={disabled || (p.mode === "change" && !(edit.comment ?? "").trim())} />;
      break;
    }
    case "filing": {
      const pr = c.proposal as FilingCardProposal;
      const place = [areaLabel(pr.area), pr.folder, pr.project].filter(Boolean).join(" › ");
      body = (
        <>
          <Excerpt value={excerpt} />
          <div class="cx-proposal">
            <p>{t("checks.place", { place, confidence: confidence ?? t("agents.none") })}</p>
            {p.mode === "change" ? (
              <label class="cx-field">
                <span>{t("checks.target")}</span>
                <input class="cx-input" type="text" value={edit.folder ?? pr.folder ?? ""} onInput={(e) => setEdit({ ...edit, folder: (e.currentTarget as HTMLInputElement).value })} />
              </label>
            ) : null}
          </div>
        </>
      );
      buttons = <StandardButtons {...p} onSave={() => p.onAnswer({ kind: "change", values: { folder: edit.folder ?? pr.folder ?? "" } })} disabled={disabled} />;
      break;
    }
    case "mention": {
      const pr = c.proposal as MentionCardProposal;
      body = (
        <>
          <blockquote class="cx-excerpt">{pr.quote}</blockquote>
          <p>{t("checks.mention", { name: pr.name })}</p>
        </>
      );
      buttons = (
        <div class="cx-check-buttons">
          <Button primary disabled={disabled} onClick={() => p.onAnswer({ kind: "mention", mine: true })}>
            {t("checks.thatsMe")}
          </Button>
          <Button disabled={disabled} onClick={() => p.onAnswer({ kind: "mention", mine: false })}>
            {t("checks.notMe")}
          </Button>
          <Button disabled={disabled} onClick={() => p.onAnswer({ kind: "skip" })}>
            {t("checks.skip")}
          </Button>
        </div>
      );
      break;
    }
    case "direction": {
      const pr = c.proposal as DirectionCardProposal;
      const draft = edit.text ?? pr.text;
      body = (
        <div class="cx-proposal">
          <p class="cx-proposal-head">
            {t("checks.directionSuggests", { model: c.model ?? "" })} {c.model ? <ModelChip>{c.model}</ModelChip> : null}
          </p>
          <p class="cx-note">{t("checks.directionPurpose", { purpose: pr.purpose })}</p>
          {p.mode === "change" ? (
            <textarea class="cx-textarea cx-direction-edit" aria-label={t("checks.directionEdit")} value={draft} onInput={(e) => setEdit({ ...edit, text: (e.currentTarget as HTMLTextAreaElement).value })} />
          ) : (
            <SafeInline text={pr.text} />
          )}
          <p class="cx-note">{t("checks.directionGiven", { given: cardGiven(pr) })}</p>
        </div>
      );
      buttons = <StandardButtons {...p} direction onSave={() => p.onAnswer({ kind: "change", values: { text: draft } })} disabled={disabled || (p.mode === "change" && cleanDirection(draft) === null)} />;
      break;
    }
    case "conflict": {
      const pr = c.proposal as ConflictCardProposal;
      body = <ConflictDiff proposal={pr} />;
      buttons = (
        <div class="cx-check-buttons">
          <Button primary disabled={disabled} onClick={() => p.onAnswer({ kind: "conflict", keep: "mine" })}>
            {t("checks.keepMine")}
          </Button>
          <Button disabled={disabled} onClick={() => p.onAnswer({ kind: "conflict", keep: "theirs" })}>
            {t("checks.useTheirs")}
          </Button>
        </div>
      );
      break;
    }
    default:
      body = <ErrorCard message={t("checks.unknown")} />;
      buttons = (
        <div class="cx-check-buttons">
          <Button disabled={disabled} onClick={() => p.onAnswer({ kind: "reject", reason: "other" })}>
            {t("checks.reject")}
          </Button>
          <Button disabled={disabled} onClick={() => p.onAnswer({ kind: "skip" })}>
            {t("checks.skip")}
          </Button>
        </div>
      );
  }

  return (
    <article class="cx-check-card" aria-label={target.title}>
      <p class="cx-check-context cx-note">{context}</p>
      <h3 class="cx-check-title">{target.title}</h3>
      {body}
      {c.reason ? (
        <div class="cx-check-why">
          <button type="button" class="cx-text-button" aria-expanded={why} onClick={() => setWhy(!why)}>
            {t("checks.why")}
          </button>
          {why ? (
            <p class="cx-machine-rule">
              <span class="cx-note">{t("checks.aiReason")}</span> <SafeInline text={c.reason} />
            </p>
          ) : null}
        </div>
      ) : null}
      {p.mode === "reject" ? (
        <div class="cx-chip-row" role="group" aria-label={t("checks.reject")}>
          {REASONS.map((r) => (
            <button type="button" class="cx-filter-chip" disabled={disabled} onClick={() => p.onAnswer({ kind: "reject", reason: r.reason })}>
              {t(r.label)}
            </button>
          ))}
        </div>
      ) : null}
      {buttons}
    </article>
  );
}

function Excerpt(p: { value: ReturnType<typeof useLoad<string | null>> }): JSX.Element | null {
  if (p.value.state !== "ready" || !p.value.value) return null;
  return (
    <blockquote class="cx-excerpt" aria-label={t("checks.excerpt")}>
      {p.value.value}
    </blockquote>
  );
}

function StandardButtons(p: { mode: "view" | "change" | "reject"; setMode(m: "view" | "change" | "reject"): void; onAnswer(a: CheckAnswer): void; onSave(): void; disabled: boolean; direction?: boolean }): JSX.Element {
  if (p.mode === "change")
    return (
      <div class="cx-check-buttons">
        <Button primary disabled={p.disabled} onClick={p.onSave}>
          {t("checks.save")}
        </Button>
        <Button onClick={() => p.setMode("view")}>{t("reader.cancel")}</Button>
      </div>
    );
  return (
    <div class="cx-check-buttons">
      <Button primary disabled={p.disabled} onClick={() => p.onAnswer({ kind: "confirm" })} title="1">
        {p.direction ? t("checks.directionAccept") : t("checks.confirm")}
      </Button>
      <Button disabled={p.disabled} onClick={() => p.setMode("change")} title="2">
        {p.direction ? t("checks.directionEditButton") : t("checks.change")}
      </Button>
      <Button disabled={p.disabled} onClick={() => p.setMode(p.mode === "reject" ? "view" : "reject")} title="3">
        {p.direction ? t("checks.directionDismiss") : t("checks.reject")}
      </Button>
      <Button disabled={p.disabled} onClick={() => p.onAnswer({ kind: "skip" })} title="4">
        {t("checks.skip")}
      </Button>
    </div>
  );
}

/** Your version and the agents' version side by side (inert text). */
function ConflictDiff(p: { proposal: ConflictCardProposal }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const ordinal = resolveOrdinal(s, p.proposal.noteId, index);
  const mine = useLoad(() => (ordinal >= 0 ? s.records.noteMarkdown(ordinal) : Promise.resolve("")), [ordinal]);
  return (
    <div class="cx-conflict">
      <p>{t("checks.conflict")}</p>
      <div class="cx-conflict-cols">
        <div>
          <h4>{t("checks.mine")}</h4>
          {mine.state === "ready" ? <pre class="cx-diff-pane">{mine.value}</pre> : <Skeleton rows={3} />}
        </div>
        <div>
          <h4>{t("checks.theirs")}</h4>
          <pre class="cx-diff-pane">{p.proposal.markdown}</pre>
        </div>
      </div>
    </div>
  );
}

function cardKindLabel(kind: ReviewCardRecord["kind"]): string {
  return kind === "label" ? t("checks.labels") : kind === "note" ? t("checks.summaries") : kind === "filing" ? t("checks.filing") : kind === "mention" ? t("checks.mentions") : kind === "direction" ? t("checks.directions") : t("checks.conflicts");
}

/** Title, source and conversation id of what a card is about (conversations, entries and notes). */
function describeTarget(s: ReturnType<typeof useServices>, index: ReturnType<typeof useIndex>, id: string): { title: string; source?: string; convId?: string } {
  try {
    if (id.startsWith("c_") && index) {
      const row = index.convs.rowOf(id);
      if (row >= 0) {
        const r = index.convs.get(row);
        return { title: r.title || t("read.untitled"), source: sourceLabel(r.source), convId: id };
      }
    }
    const m = metaOf(s, resolveOrdinal(s, id, index));
    if (m) return { title: m.title || kindLabel(m.noteKind ?? "entry"), source: sourceLabel(m.source), convId: m.conversation?.id };
  } catch {
    // fall through to the generic title
  }
  return { title: t("checks.target") };
}
