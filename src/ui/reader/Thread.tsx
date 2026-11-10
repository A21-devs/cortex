/**
 * Thread (CORTEX-UX §5.30.2): the whole conversation. The frond scrubber pinned at the top acts as the scroll
 * position; messages in order with speaker marker, time and text (SafeMarkdown); part dividers labelled as on
 * the stem; imported tool output collapsed to "Tool output · ‹n› lines"; 200 messages at a time with Earlier /
 * Later and "Go to message ‹n›"; the message you came from is highlighted; Ctrl F finds within the
 * conversation. Paged through RecordReader.conversationSlice(). Owner: E12.
 */
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConversationDetail } from "../../plugin/services";
import type { Speaker } from "../../shared/types";
import { useServices } from "../context";
import { t } from "../copy";
import { Load, useFmt, useLoad } from "../pages/PageFrame";
import { speakerLabel, isoMs } from "../valueLabels";
import { resolveConversation } from "./ConversationReader";
import { FrondScrubber } from "./FrondScrubber";
import { SpeakerMarker } from "./marks";
import { idOf, metaOf, resolveOrdinal, useIndex } from "./readerKit";
import { SafeMarkdown } from "./SafeMarkdown";

export const THREAD_PAGE = 200;

/** The page [from, to) of a thread that holds message `n` (0-based), `size` messages at a time. */
export function pageFor(n: number, count: number, size: number = THREAD_PAGE): { from: number; to: number } {
  const clamped = Math.max(0, Math.min(Math.max(0, count - 1), n));
  const from = Math.floor(clamped / size) * size;
  return { from, to: Math.min(count, from + size) };
}

/** The label of the part a message index falls in ("Part 2"), or null before the first part break. */
export function partAt(parts: ConversationDetail["parts"], messageIndex: number): ConversationDetail["parts"][number] | null {
  return parts.find((p) => messageIndex >= p.msgFrom && messageIndex <= p.msgTo) ?? null;
}

/** The message numbers (0-based, `offset` + position) whose text holds `query`, case-insensitively. */
export function findMatches(messages: readonly { text: { ok: boolean; text?: string } }[], offset: number, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  messages.forEach((m, i) => {
    if (m.text.ok && typeof m.text.text === "string" && m.text.text.toLowerCase().includes(q)) out.push(offset + i);
  });
  return out;
}

/** The next (or previous) match position, wrapping round the ends. */
export function stepMatch(at: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  return at < 0 ? (dir === 1 ? 0 : total - 1) : (at + dir + total) % total;
}

export function Thread(p: { id: string }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const detail = useLoad(async () => {
    const convId = await resolveConversation(s, p.id, index);
    return s.records.conversation(convId);
  }, [p.id, index]);
  return <Load value={detail} failed={t("errors.reader")}>{(d) => <ThreadView id={p.id} detail={d} />}</Load>;
}

function ThreadView(p: { id: string; detail: ConversationDetail }): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const index = useIndex(s);
  const d = p.detail;
  const count = d.record.entryCount;
  const cameFrom = useMemo(() => {
    if (p.id.startsWith("c_")) return -1;
    const o = resolveOrdinal(s, p.id, index);
    return o >= 0 ? (metaOf(s, o)?.conversation?.index ?? -1) : -1;
  }, [p.id, index]);
  const [from, setFrom] = useState(() => pageFor(Math.max(0, cameFrom), count).from);
  const to = Math.min(count, from + THREAD_PAGE);
  const [goto, setGoto] = useState("");
  const [find, setFind] = useState("");
  /** Message numbers across the whole conversation that hold the find text, and the one stepped to. */
  const [matches, setMatches] = useState<number[]>([]);
  const [matchAt, setMatchAt] = useState(-1);
  const [current, setCurrent] = useState(Math.max(0, cameFrom));
  const listRef = useRef<HTMLDivElement>(null);
  const slice = useLoad(() => s.records.conversationSlice(d.record.id, from, to), [d.record.id, from, to]);

  // Bring the message you came from into view once its page is there.
  useEffect(() => {
    if (cameFrom < 0 || slice.state !== "ready") return;
    listRef.current?.querySelector<HTMLElement>(`[data-n="${cameFrom}"]`)?.scrollIntoView?.({ block: "center" });
  }, [slice.state, cameFrom]);

  // Count the matches over the whole conversation (a page at a time), not just the messages on screen.
  useEffect(() => {
    const q = find.trim();
    setMatchAt(-1);
    if (!q) {
      setMatches([]);
      return undefined;
    }
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        const found: number[] = [];
        for (let a = 0; a < count && live; a += THREAD_PAGE) {
          const page = await s.records.conversationSlice(d.record.id, a, Math.min(count, a + THREAD_PAGE)).catch(() => []);
          found.push(...findMatches(page, a, q));
        }
        if (live) setMatches(found);
      })();
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [find, d.record.id, count]);
  const stepFind = (dir: 1 | -1) => {
    const next = stepMatch(matchAt, matches.length, dir);
    if (next < 0) return;
    setMatchAt(next);
    jump(matches[next] as number);
  };
  const goNow = () => {
    const n = Number(goto);
    if (Number.isFinite(n) && n >= 1) jump(Math.floor(n) - 1);
  };

  const whenOf = (i: number): string => {
    const m = slice.state === "ready" ? slice.value[i] : undefined;
    const ms = m ? isoMs(metaOf(s, m.ordinal)?.writtenAt) : Number.NaN;
    return Number.isFinite(ms) ? fmt.dateTime(ms, true) : "";
  };
  const speakers: Speaker[] = slice.state === "ready" ? slice.value.map((m) => m.speaker) : [];
  const jump = (n: number) => {
    const target = Math.max(0, Math.min(count - 1, n));
    const page = pageFor(target, count);
    setCurrent(target);
    if (page.from !== from) setFrom(page.from);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-n="${target}"]`)?.scrollIntoView?.({ block: "start" }));
  };

  return (
    <article
      class="cx-thread"
      data-id={p.id}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>(".cx-thread-find")?.focus();
        }
      }}
    >
      <header class="cx-thread-head">
        <h2 class="cx-reader-title">{d.record.title}</h2>
        <FrondScrubber
          speakers={speakers}
          index={Math.max(0, current - from)}
          partStarts={d.parts.slice(1).map((x) => x.msgFrom - from).filter((n) => n > 0 && n < speakers.length)}
          label={t("reader.scrubKey")}
          describe={(i) => t("reader.scrubValue", { i: from + i + 1, n: count, speaker: speakerLabel(speakers[i] ?? "assistant"), date: whenOf(i) })}
          onStep={(i) => jump(from + i)}
        />
        <div class="cx-thread-tools">
          <input class="cx-input cx-thread-find" type="search" aria-label={t("reader.findInThread")} placeholder={t("reader.findInThread")} value={find}
            onInput={(e) => setFind((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stepFind(e.shiftKey ? -1 : 1);
              }
            }}
          />
          {find.trim() ? (
            <>
              <span class="cx-note cx-mono cx-find-count" role="status">
                {matches.length === 0 ? t("reader.noMatches") : t("reader.findCount", { i: matchAt < 0 ? 0 : matchAt + 1, n: matches.length })}
              </span>
              <button type="button" class="cx-text-button" aria-label={t("reader.findPrevious")} disabled={matches.length === 0} onClick={() => stepFind(-1)}>
                ↑
              </button>
              <button type="button" class="cx-text-button" aria-label={t("reader.findNext")} disabled={matches.length === 0} onClick={() => stepFind(1)}>
                ↓
              </button>
            </>
          ) : null}
          <input
            class="cx-input cx-thread-goto"
            type="number"
            min={1}
            max={count}
            aria-label={t("reader.goTo")}
            placeholder={t("reader.goTo")}
            value={goto}
            onInput={(e) => setGoto((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goNow();
            }}
          />
          <button type="button" class="cx-text-button" onClick={goNow}>
            {t("reader.goButton")}
          </button>
        </div>
        <nav class="cx-thread-pager" aria-label={t("reader.threadNav")}>
          <button type="button" class="cx-text-button" disabled={from === 0} onClick={() => setFrom(Math.max(0, from - THREAD_PAGE))}>
            {t("reader.earlier")}
          </button>
          <span class="cx-mono cx-note">{t("reader.threadRange", { from: from + 1, to, total: count })}</span>
          <button type="button" class="cx-text-button" disabled={to >= count} onClick={() => setFrom(from + THREAD_PAGE)}>
            {t("reader.later")}
          </button>
        </nav>
      </header>
      <div class="cx-thread-list" ref={listRef}>
        <Load value={slice} failed={t("errors.reader")} rows={6}>
          {(messages) => (
            <>
              {messages.map((m, i) => {
                const n = from + i;
                const part = d.parts.find((x) => x.msgFrom === n && n > 0);
                const meta = metaOf(s, m.ordinal);
                const when = isoMs(meta?.writtenAt);
                return (
                  <>
                    {part ? <h3 class="cx-thread-part">{part.title ? `${t("reader.partPlain", { n: part.n })} · ${part.title}` : t("reader.partPlain", { n: part.n })}</h3> : null}
                    <div class={`cx-thread-msg is-${m.speaker}${n === cameFrom ? " is-from" : ""}`} data-n={n} id={`cx-msg-${idOf(s, m.ordinal, index) ?? n}`}>
                      <div class="cx-thread-meta">
                        <SpeakerMarker speaker={m.speaker} />
                        <span class="cx-note">{speakerLabel(m.speaker)}</span>
                        <span class="cx-note cx-mono">{Number.isFinite(when) ? fmt.dateTime(when, true) : ""}</span>
                        <span class="cx-note cx-mono">{n + 1}</span>
                      </div>
                      {m.text.ok ? (
                        m.speaker === "tool" ? (
                          <details>
                            <summary>{t("reader.toolOutput", { n: m.text.text.split("\n").length })}</summary>
                            <pre class="cx-diff-pane">{m.text.text}</pre>
                          </details>
                        ) : (
                          <SafeMarkdown text={m.text.text} highlight={find.trim() || undefined} />
                        )
                      ) : (
                        <p class="cx-note">{t("errors.reader")}</p>
                      )}
                    </div>
                  </>
                );
              })}
            </>
          )}
        </Load>
      </div>
    </article>
  );
}
