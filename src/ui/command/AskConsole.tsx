/**
 * Ask console (CORTEX-UX §5.10; ORIG-08). Owner: E6.
 * Rises from the command line (same width, ≤ min(520, 62% of stage)). Header: glyph, "Ask Cortex", the engine
 * line "Claude Code · ‹model› · answers only from your record", History (→ Change history), Keep open, Collapse.
 * Purpose line: "Ask about your record or change how it is shown. Every change can be undone."
 * Empty state: NO title sentence and NO fixed example grid — the slash commands (slashCommands.ts) that insert a
 * template, plus up to three "Try" suggestions generated from the user's own recent record
 * (AssistantExecutor.suggestions()).
 * Thread: your messages right-aligned; replies left with the machine avatar; citation chips (hover → passage;
 * click → reader); CHANGES (receipts: "Undo change", "Change history") and Apply cards (Apply / Cancel, "Enter
 * applies · Esc cancels"; refresh and propose_filing show Cortex's token + item estimate). Progress "Reading ‹n›
 * entries…" with Stop; after 20 s "Still working…". Errors from the catalogue (timeout 90 s, engine, cap, invalid
 * reply, dropped statement, too broad, sample). role="log", aria-live polite.
 *
 * The command line (E12) keeps the typed text in `ui.command.text` and opens this console. The console listens for
 * Enter, Tab (slash completion) and, while a proposal waits and the input is empty, Enter / Esc on the command
 * input, and sends the text to AssistantExecutor.ask().
 */
import { signal, type Signal } from "@preact/signals";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AskErrorCode, AskEvent, AskOutcome, UndoPreview } from "../../plugin/aiExecutor";
import type { CortexServices } from "../../plugin/services";
import { openItem, openPage } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import type { ReceiptView } from "../../state/types";
import { useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { Button, Glyph, IconButton, TextButton } from "../primitives/buttons";
import { openCortexSettings } from "../pages/PageFrame";
import { fmtDate, isoMs } from "../valueLabels";
import { markNotMine } from "./notMine";
import { parseSlash, SLASH_COMMANDS, type SlashCommand } from "./slashCommands";

export type Turn =
  | { kind: "you"; text: string }
  | { kind: "reply"; outcome: AskOutcome }
  | { kind: "error"; code: AskErrorCode; raw?: string; resumeAt?: string };

interface Running {
  askId?: string;
  key: "reading" | "thinking" | "still-working";
  count?: number;
}

const threads = new WeakMap<CortexStore, Signal<Turn[]>>();
const runs = new WeakMap<CortexStore, Signal<Running | null>>();
const MAX_TURNS = 80;

function threadOf(store: CortexStore): Signal<Turn[]> {
  let sig = threads.get(store);
  if (!sig) threads.set(store, (sig = signal<Turn[]>([])));
  return sig;
}

function runOf(store: CortexStore): Signal<Running | null> {
  let sig = runs.get(store);
  if (!sig) runs.set(store, (sig = signal<Running | null>(null)));
  return sig;
}

/** Reopen a past thread in the console (Change history, Ask history): your questions and the replies' text. */
export function loadThread(store: CortexStore, threadId: string, exchanges: readonly { askId: string; question: string; reply: string }[]): void {
  const turns: Turn[] = [];
  for (const x of exchanges) {
    if (x.question) turns.push({ kind: "you", text: x.question });
    turns.push({ kind: "reply", outcome: { askId: x.askId, reply: x.reply, citations: [], changes: [], declined: [], droppedStatements: 0 } });
  }
  threadOf(store).value = turns.slice(-MAX_TURNS);
  store.update("ui", (ui) => ({ ...ui, command: { ...ui.command, mode: "ask", consoleOpen: true, threadId } }));
}

/** The copy for an error code (everything comes from the catalogue; nothing is model text). */
export function errorText(code: AskErrorCode, s: Pick<CortexServices, "settings">, extra: { resumeAt?: string; count?: number } = {}): string {
  const agents = s.settings.value.agents;
  switch (code) {
    case "timeout":
      return t("ask.timeout", { s: agents.askTimeoutSec });
    case "missing":
      if (agents.engine === "none") return t("ask.noModel");
      if (agents.engine === "codex-cli") return t("ask.missingCodex", { path: agents.codex.path || "codex" });
      return t("ask.missing", { path: agents.claudePath || "claude" });
    case "auth":
      return t("ask.signIn");
    case "capped":
      return t("ask.capped");
    case "paused":
      return t("agents.paused");
    case "no-grant":
      return t("consent.noGrantAsk");
    case "offline":
      return t("agents.offline");
    case "limit":
      return t("agents.limit", { time: extra.resumeAt ? new Date(extra.resumeAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "…" });
    case "invalid-reply":
      return t("ask.invalid");
    case "too-broad":
      return t("ask.tooBroad", { n: extra.count ?? 0 });
    case "not-allowed":
      return t("ask.notAllowed");
    case "sample":
      return t("ask.sample");
    case "cancelled":
      return "";
  }
}

/** Slash commands whose name starts with what is typed after "/". */
export function matchSlash(text: string): SlashCommand[] {
  const m = /^\/([a-z-]*)$/.exec(text);
  return m ? SLASH_COMMANDS.filter((c) => c.name.startsWith(m[1] as string)) : [];
}

function focusInput(): void {
  document.querySelector<HTMLInputElement>(".cx-command-input")?.focus();
}

/** Send the typed text: a slash command restricts the model to its verb; an unknown one is "not allowed". */
export async function sendAsk(s: CortexServices, store: CortexStore, viewId: string, text: string): Promise<void> {
  const body = text.trim();
  const run = runOf(store);
  if (body.length === 0 || run.peek() !== null) return;
  const thread = threadOf(store);
  const push = (turn: Turn): void => void (thread.value = [...thread.peek(), turn].slice(-MAX_TURNS));
  const slash = body.startsWith("/") ? parseSlash(body) : null;
  push({ kind: "you", text: body });
  store.update("ui", (ui) => ({ ...ui, command: { ...ui.command, text: "", resultsOpen: false } }));
  if (body.startsWith("/") && !slash) return push({ kind: "error", code: "not-allowed" });
  const ui = store.get("ui");
  const threadId = ui.command.threadId ?? `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (ui.command.threadId === null) store.update("ui", (u) => ({ ...u, command: { ...u.command, threadId } }));
  const view = store.get("view");
  run.value = { key: "thinking" };
  try {
    const events: AsyncIterable<AskEvent> = s.assistant.ask(body, { threadId, viewId, ...(slash ? { onlyVerb: slash.command.verbs } : {}), ...(view.shape === "chart" && view.chart ? { chart: true } : {}) });
    for await (const ev of events) {
      if (ev.kind === "progress") run.value = { askId: ev.askId, key: ev.key, ...(ev.count !== undefined ? { count: ev.count } : {}) };
      else if (ev.kind === "reply") push({ kind: "reply", outcome: ev.outcome });
      else push({ kind: "error", code: ev.code, ...(ev.raw !== undefined ? { raw: ev.raw } : {}), ...(ev.resumeAt !== undefined ? { resumeAt: ev.resumeAt } : {}) });
    }
  } catch {
    push({ kind: "error", code: "offline" });
  } finally {
    run.value = null;
  }
}

function citeRoute(id: string): "entry" | "note" | "vault-peek" {
  return id.startsWith("e_") ? "entry" : id.startsWith("w_") ? "vault-peek" : "note";
}

export function AskConsole(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const ui = store.slices.ui.value;
  const thread = threadOf(store).value;
  const running = runOf(store).value;
  const receipts = s.shared.slices.receipts.value;
  const activity = s.shared.slices.activity.value;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ id: string; preview: UndoPreview } | null>(null);
  const [rawOpen, setRawOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const text = ui.command.text;
  const live = (c: ReceiptView): ReceiptView => receipts.find((r) => r.id === c.id) ?? c;

  useEffect(() => {
    let alive = true;
    void s.assistant.suggestions().then(
      (list) => alive && setSuggestions(list),
      () => alive && setSuggestions([]),
    );
    return () => {
      alive = false;
    };
  }, [s, thread.length === 0]);

  useEffect(() => {
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
  }, [thread.length, running?.key]);

  // The command input belongs to the command line; the console reads its Enter, Tab, Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (!el?.classList?.contains("cx-command-input") || e.isComposing) return;
      const cmd = store.get("ui").command;
      if (cmd.mode !== "ask") return;
      const waiting = s.shared.get("receipts").filter((r) => r.needsApply);
      const next = waiting[waiting.length - 1];
      if (cmd.text.trim() === "" && next && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void (e.key === "Enter" ? s.assistant.apply(next.id) : s.assistant.reject(next.id)).catch(() => undefined);
        return;
      }
      if (e.key === "Enter" && cmd.text.trim() !== "") {
        e.preventDefault();
        // One-step slash commands (/not-mine) act on the selection at once and ask no model.
        if (parseSlash(cmd.text)?.command.direct === "not-mine") {
          store.update("ui", (u) => ({ ...u, command: { ...u.command, text: "" } }));
          void markNotMine(s, leaf, shell);
          return;
        }
        void sendAsk(s, store, leaf.viewId, cmd.text);
      } else if (e.key === "Tab" && !e.shiftKey) {
        const first = matchSlash(cmd.text)[0];
        if (!first) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        store.update("ui", (u) => ({ ...u, command: { ...u.command, text: t(first.insert) } }));
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [s, store, leaf.viewId]);

  const insert = (c: SlashCommand | string): void => {
    if (typeof c !== "string" && c.direct === "not-mine") {
      store.update("ui", (u) => ({ ...u, command: { ...u.command, text: "" } }));
      void markNotMine(s, leaf, shell);
      return;
    }
    store.update("ui", (u) => ({ ...u, command: { ...u.command, text: typeof c === "string" ? c : t(c.insert) } }));
    focusInput();
  };

  const undo = async (c: ReceiptView): Promise<void> => {
    try {
      const preview = await s.assistant.undoPreview(c.id);
      if (preview.alsoUndoes.length > 0) return setConfirm({ id: c.id, preview });
      await s.assistant.undo(c.id);
    } catch {
      /* the receipt keeps its state; nothing was changed */
    }
  };

  const fmt = s.settings.value.general.dateFormat;
  const slashMenu = matchSlash(text);
  const changeCard = (c0: ReceiptView): JSX.Element => {
    const c = live(c0);
    const stateText = c.state === "applied" ? t("changes.applied") : c.state === "undone" ? t("changes.undone") : c.state === "proposed" ? t("changes.waiting") : "";
    const asking = confirm?.id === c.id ? confirm : null;
    return (
      <li class={`cx-change is-${c.state}${c.needsApply ? " is-proposal" : ""}`} data-change={c.id}>
        <span class="cx-change-summary">{c.summary}</span>
        {stateText ? <span class="cx-change-state">{stateText}</span> : null}
        {c.estimate ? <p class="cx-change-estimate">{t("ask.estimate", { items: c.estimate.items.toLocaleString("en-GB"), tokens: c.estimate.tokens.toLocaleString("en-GB") })}</p> : null}
        {c.reason ? <p class="cx-change-reason">{t("ask.aiReason", { reason: c.reason })}</p> : null}
        {c.needsApply ? (
          <div class="cx-change-actions">
            <Button primary onClick={() => void s.assistant.apply(c.id).catch(() => undefined)}>
              {t("ask.apply")}
            </Button>
            <Button onClick={() => void s.assistant.reject(c.id).catch(() => undefined)}>{t("ask.cancel")}</Button>
            <span class="cx-hint-text">{t("ask.applyHint")}</span>
          </div>
        ) : null}
        {c.canUndo && !asking ? (
          <div class="cx-change-actions">
            <TextButton onClick={() => void undo(c)}>{c.spendsBudget && c.action !== "propose_filing" ? t("ask.cancel") : t("ask.undo")}</TextButton>
            <TextButton onClick={() => openPage(store, "change-history")}>{t("ask.history")}</TextButton>
          </div>
        ) : null}
        {asking ? (
          <div class="cx-change-actions" role="alert">
            <span>{t("ask.undoAlso", { date: fmtDate(isoMs(asking.preview.alsoUndoes[0]?.at), fmt) })}</span>
            <Button
              primary
              onClick={() =>
                void s.assistant
                  .undo(c.id, { both: true })
                  .catch(() => undefined)
                  .then(() => setConfirm(null))
              }
            >
              {t("ask.undoBoth")}
            </Button>
            <Button onClick={() => setConfirm(null)}>{t("ask.cancel")}</Button>
          </div>
        ) : null}
      </li>
    );
  };

  const turn = (tn: Turn, i: number): JSX.Element | null => {
    if (tn.kind === "you") {
      const m = /^(\/[a-z-]+)(\s.*)?$/s.exec(tn.text);
      return (
        <div class="cx-turn is-you" key={i}>
          <p class="cx-bubble">
            {m ? <span class="cx-mono">{m[1]}</span> : null}
            {m ? (m[2] ?? "") : tn.text}
          </p>
        </div>
      );
    }
    if (tn.kind === "error") {
      const out = errorText(tn.code, s, { ...(tn.resumeAt !== undefined ? { resumeAt: tn.resumeAt } : {}) });
      if (!out) return null;
      return (
        <div class="cx-turn is-error" key={i} role="status">
          <p>{out}</p>
          {tn.code === "missing" ? <TextButton onClick={() => openCortexSettings(s.app, "agents")}>{t("ask.openSettings")}</TextButton> : null}
          {tn.code === "invalid-reply" && tn.raw ? (
            <>
              <TextButton onClick={() => setRawOpen(rawOpen === i ? null : i)}>{t("ask.showRaw")}</TextButton>
              {rawOpen === i ? <pre class="cx-raw">{tn.raw}</pre> : null}
            </>
          ) : null}
        </div>
      );
    }
    const o = tn.outcome;
    return (
      <div class="cx-turn is-reply" key={i}>
        <span class="cx-avatar" aria-hidden="true">
          <Glyph size={14} />
        </span>
        <div class="cx-reply">
          {o.reply ? <p class="cx-reply-text">{o.reply}</p> : null}
          {o.citations.length > 0 ? (
            <p class="cx-citations">
              {o.citations.map((c) => (
                <button
                  type="button"
                  class="cx-cite"
                  key={c.ordinal}
                  title={c.quote}
                  aria-label={`${c.ordinal}: ${c.quote}`}
                  onClick={() => {
                    const ord = s.index.ordinalOf(c.id);
                    if (ord >= 0) openItem(store, ord, c.id, citeRoute(c.id));
                  }}
                >
                  {c.ordinal}
                </button>
              ))}
            </p>
          ) : null}
          {o.droppedStatements > 0 ? <p class="cx-note">{t("ask.dropped")}</p> : null}
          {o.declined.map((d, k) => (
            <p class="cx-note" key={`d${k}`}>
              {d.reason === "too-broad" ? t("ask.tooBroad", { n: d.count ?? 0 }) : d.reason === "not-allowed" ? t("ask.notAllowed") : t("ask.invalid")}
            </p>
          ))}
          {o.changes.length > 0 ? (
            <ul class="cx-changes" aria-label={t("changes.applied")}>
              {o.changes.map(changeCard)}
            </ul>
          ) : null}
        </div>
      </div>
    );
  };

  const pinned = ui.command.consolePinned;
  return (
    <section class="cx-console" role="log" aria-live="polite" aria-label={t("ask.title")}>
      <header class="cx-console-header">
        <span class="cx-glyph" aria-hidden="true">
          <Glyph size={15} />
        </span>
        <span class="cx-console-title">{t("ask.title")}</span>
        <span class="cx-console-engine">{t("ask.engine", { model: s.settings.value.agents.models.ask })}</span>
        <IconButton icon="history" label={t("ask.history")} size={28} onClick={() => openPage(store, "change-history")} />
        <IconButton icon="pin" label={t("ask.keepOpen")} size={28} pressed={pinned} onClick={() => store.update("ui", (u) => ({ ...u, command: { ...u.command, consolePinned: !u.command.consolePinned } }))} />
        <IconButton icon="chevron" label={t("ask.collapse")} size={28} disabled={running !== null} onClick={() => store.update("ui", (u) => ({ ...u, command: { ...u.command, consoleOpen: false } }))} />
      </header>
      <div class="cx-console-body" ref={listRef}>
        <p class="cx-console-purpose">{t("ask.purpose")}</p>
        {thread.length === 0 ? (
          <>
            <ul class="cx-slash-list">
              {SLASH_COMMANDS.map((c) => (
                <li key={c.name}>
                  <button type="button" class="cx-slash-row" data-template={t(c.insert)} onClick={() => insert(c)}>
                    <span class="cx-mono">/{c.name}</span>
                    <span>{t(c.key)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {suggestions.length > 0 ? (
              <div class="cx-try">
                <span class="cx-try-label">{t("ask.try")}</span>
                {suggestions.map((q) => (
                  <button type="button" class="cx-try-row" key={q} onClick={() => insert(q)}>
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          thread.map(turn)
        )}
        {running ? (
          <div class="cx-turn is-progress" role="status">
            <p>{running.key === "reading" ? t("ask.reading", { n: running.count ?? 0 }) : running.key === "still-working" ? t("ask.stillWorking") : t("ask.thinking")}</p>
            <span class="cx-progress" aria-hidden="true" />
            <TextButton onClick={() => (running.askId ? s.assistant.cancel(running.askId) : undefined)}>{t("ask.stop")}</TextButton>
          </div>
        ) : null}
      </div>
      {slashMenu.length > 0 && thread.length > 0 ? (
        <ul class="cx-slash-menu" role="listbox">
          {slashMenu.map((c) => (
            <li role="option" aria-selected={false} key={c.name}>
              <button type="button" class="cx-slash-row" onClick={() => insert(c)}>
                <span class="cx-mono">/{c.name}</span>
                <span>{t(c.key)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
