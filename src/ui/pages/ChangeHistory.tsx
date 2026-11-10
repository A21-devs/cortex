/**
 * Change history (CORTEX-UX §5.30.5): two tabs. Changes: grouped by day, each change card with its state
 * (applied, undone, waiting for Apply), filter chips View · Data · Agents; data changes keep Undo change for
 * good. Ask history: past exchanges by day; a click reopens the thread in the console; each exchange can be left
 * out like any entry. Empty: "No changes yet." / "No Ask exchanges yet." Data: AssistantExecutor.changes() and
 * history(). Owner: E6.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { AskExchangeView, ChangeFilter } from "../../plugin/aiExecutor";
import type { ReceiptView } from "../../state/types";
import { loadThread } from "../command/AskConsole";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { TextButton } from "../primitives/buttons";
import { isoMs } from "../valueLabels";
import { Load, PageFrame, PageTabs, pick, setPageParams, ToggleButton, useFmt, useLoad } from "./PageFrame";

/** Group items by their ISO day, newest day first. */
export function byDay<T extends { at: string }>(items: readonly T[]): { day: string; items: T[] }[] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const d = it.at.slice(0, 10);
    m.set(d, [...(m.get(d) ?? []), it]);
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, items]) => ({ day, items }));
}

const FILTERS: readonly { id: ChangeFilter; label: "history.view" | "history.data" | "history.agents" }[] = [
  { id: "view", label: "history.view" },
  { id: "data", label: "history.data" },
  { id: "agents", label: "history.agents" },
];

/** The state word on a change card. */
export function stateLabel(state: ReceiptView["state"]): string {
  return state === "applied" ? t("changes.applied") : state === "undone" ? t("changes.undone") : state === "proposed" ? t("changes.waiting") : "";
}

function ChangesTab(): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const [filter, setFilter] = useState<ChangeFilter | null>(null);
  const [rev, setRev] = useState(0);
  const [also, setAlso] = useState<{ id: string; at: string } | null>(null);
  const data = useLoad(() => s.assistant.changes(filter ? { filter } : {}), [s, filter, rev]);
  const undo = async (c: ReceiptView): Promise<void> => {
    try {
      const preview = await s.assistant.undoPreview(c.id);
      const first = preview.alsoUndoes[0];
      if (first) return setAlso({ id: c.id, at: first.at });
      await s.assistant.undo(c.id);
      setRev((n) => n + 1);
    } catch {
      /* the change keeps its state */
    }
  };
  const undoBoth = (c: ReceiptView): void => {
    void s.assistant
      .undo(c.id, { both: true })
      .catch(() => undefined)
      .then(() => {
        setAlso(null);
        setRev((n) => n + 1);
      });
  };
  return (
    <>
      <div class="cx-chip-row" role="group" aria-label={t("history.changes")}>
        {FILTERS.map((f) => (
          <ToggleButton key={f.id} pressed={filter === f.id} onToggle={(on) => setFilter(on ? f.id : null)}>
            {t(f.label)}
          </ToggleButton>
        ))}
      </div>
      <Load value={data} failed={t("app.failed")}>
        {(rows) =>
          rows.length === 0 ? (
            <p class="cx-note">{t("history.noChanges")}</p>
          ) : (
            <>
              {byDay(rows).map((g) => (
                <section class="cx-day" key={g.day}>
                  <h3 class="cx-day-title">{fmt.date(isoMs(g.day), true)}</h3>
                  <ul class="cx-changes">
                    {g.items.map((c) => (
                      <li class={`cx-change is-${c.state}`} key={c.id}>
                        <span class="cx-change-summary">{c.summary}</span>
                        <span class="cx-change-state">{stateLabel(c.state)}</span>
                        {c.reason ? <p class="cx-change-reason">{t("ask.aiReason", { reason: c.reason })}</p> : null}
                        {c.canUndo && also?.id !== c.id ? <TextButton onClick={() => void undo(c)}>{c.spendsBudget && c.action !== "propose_filing" ? t("ask.cancel") : t("ask.undo")}</TextButton> : null}
                        {also?.id === c.id ? (
                          <div class="cx-change-actions" role="alert">
                            <span>{t("ask.undoAlso", { date: fmt.date(isoMs(also.at), true) })}</span>
                            <TextButton onClick={() => undoBoth(c)}>{t("ask.undoBoth")}</TextButton>
                            <TextButton onClick={() => setAlso(null)}>{t("ask.cancel")}</TextButton>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )
        }
      </Load>
    </>
  );
}

function AskTab(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const [rev, setRev] = useState(0);
  const data = useLoad(() => s.assistant.history({}), [s, rev]);
  const reopen = (x: AskExchangeView, all: readonly AskExchangeView[]): void => {
    const thread = all.filter((e) => e.threadId === x.threadId).sort((a, b) => (a.at < b.at ? -1 : 1));
    loadThread(leaf.store, x.threadId, thread);
  };
  const leaveOut = async (x: AskExchangeView): Promise<void> => {
    try {
      for (const id of [x.questionEntry, x.replyEntry]) if (id) await s.corrections.exclude(id, "entry", "ask");
      setRev((n) => n + 1);
    } catch {
      /* nothing was left out */
    }
  };
  return (
    <Load value={data} failed={t("app.failed")}>
      {(rows) =>
        rows.length === 0 ? (
          <p class="cx-note">{t("history.noAsk")}</p>
        ) : (
          <>
            {byDay(rows).map((g) => (
              <section class="cx-day" key={g.day}>
                <h3 class="cx-day-title">{fmt.date(isoMs(g.day), true)}</h3>
                <ul class="cx-exchanges">
                  {g.items.map((x) => (
                    <li class="cx-exchange" key={x.askId}>
                      <button type="button" class="cx-exchange-open" onClick={() => reopen(x, rows)}>
                        <span class="cx-exchange-q">{x.question || t("ask.title")}</span>
                        {x.reply ? <span class="cx-exchange-a">{x.reply.length > 160 ? `${x.reply.slice(0, 159)}…` : x.reply}</span> : null}
                      </button>
                      <TextButton onClick={() => void leaveOut(x)}>{t("reader.leaveOut")}</TextButton>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )
      }
    </Load>
  );
}

export function ChangeHistory(p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const leaf = useLeaf();
  const tab = pick(p.params.tab, ["changes", "ask"] as const, "changes");
  return (
    <PageFrame
      tabs={
        <PageTabs
          value={tab}
          label={t("ask.history")}
          options={[
            { value: "changes", label: t("history.changes") },
            { value: "ask", label: t("history.askHistory") },
          ]}
          onChange={(v) => setPageParams(leaf.store, { tab: v === "changes" ? null : v })}
        />
      }
    >
      {tab === "ask" ? <AskTab /> : <ChangesTab />}
    </PageFrame>
  );
}
