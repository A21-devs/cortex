/**
 * Toasts (CORTEX-UX §5.11, §3.5): stage bottom right, 330 px, at most 3, stacking upward (newest at the bottom).
 *  - Changes (receipts from Ask, the key's merge, Display reset): Cortex's own summary + "Undo change"; they leave
 *    after 8 s, and resting the pointer on a toast pauses that.
 *  - Held arrivals (P1): "‹n› new entries from ‹k› Claude Code sessions" · "Held back so the view doesn't shift
 *    while you look" · Show them (until shown or dismissed).
 *  - The frame-rate governor's "Cortex lowered detail…" and background errors (errors stay until dismissed).
 * Receipt summaries are Cortex's text, never model text. Only receipts made while this view is open appear.
 * Owner: E11.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { revealArrivals } from "../../state/actions";
import { heldArrivals } from "../../state/selectors";
import type { ReceiptView } from "../../state/types";
import { SHELL } from "../breakpoints";
import { num, pendingCopy, useLeaf, useServices, useShell, type ShellToast } from "../context";
import { t } from "../copy";
import { isDesktopHost } from "../host";
import { Icon, IconButton, TextButton } from "../primitives/buttons";

export const TOAST_MS = SHELL.timing.toastMs;
export const MAX_TOASTS = SHELL.geometry.toast.max;

export interface ToastView {
  id: string;
  kind: ShellToast["kind"];
  text: string;
  detail?: string;
  action?: { label: string; run(): void };
  undo?: () => void | Promise<void>;
  sticky: boolean;
  at: number;
}

/** Receipts that become toasts: applied changes and failures made since the view opened, not dismissed. */
export function receiptToasts(receipts: readonly ReceiptView[], dismissed: ReadonlySet<string>, openedAt: number, undo: (id: string) => Promise<void>): ToastView[] {
  const out: ToastView[] = [];
  for (const r of receipts) {
    const at = Date.parse(r.at);
    if (dismissed.has(r.id) || !Number.isFinite(at) || at < openedAt - 1000) continue;
    if (r.state === "applied") out.push({ id: r.id, kind: "change", text: r.summary, sticky: false, at, undo: r.canUndo ? () => undo(r.id) : undefined });
    else if (r.state === "failed") out.push({ id: r.id, kind: "error", text: r.summary, sticky: true, at });
  }
  return out;
}

/** The arrivals line for `n` held items, grammatical for any count; `sessions` is how many Claude Code sessions they came from (0 = unknown). */
export function arrivalsText(n: number, sessions: number): string {
  if (sessions <= 0) return n === 1 ? t("toasts.arrivalsOne") : t("toasts.arrivalsItems", { n: num(n) });
  if (n === 1) return sessions === 1 ? t("toasts.arrivalsEntryFromOne") : t("toasts.arrivalsEntryFrom", { k: num(sessions) });
  return sessions === 1 ? t("toasts.arrivalsOneSession", { n: num(n) }) : t("toasts.arrivals", { n: num(n), k: num(sessions) });
}

/** Every toast of this leaf, newest last, at most three. */
export function visibleToasts(local: readonly ShellToast[], fromReceipts: readonly ToastView[], arrivals: ToastView | null): ToastView[] {
  const all: ToastView[] = [...local.map((l) => ({ ...l, sticky: l.sticky === true || l.kind === "error" || l.kind === "arrivals" })), ...fromReceipts];
  if (arrivals) all.push(arrivals);
  all.sort((a, b) => a.at - b.at);
  return all.slice(-MAX_TOASTS);
}

function ToastItem(p: { toast: ToastView; onDismiss(): void }): JSX.Element {
  const shell = useShell();
  const tv = p.toast;
  const left = useRef(TOAST_MS);
  const started = useRef(0);
  const timer = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const stop = () => {
    if (timer.current !== null) shell.win.clearTimeout(timer.current);
    timer.current = null;
  };
  const start = () => {
    if (tv.sticky) return;
    stop();
    started.current = shell.now();
    timer.current = shell.win.setTimeout(() => p.onDismiss(), Math.max(0, left.current));
  };
  useEffect(() => {
    start();
    return stop;
  }, [tv.id]);
  const pause = () => {
    if (tv.sticky || timer.current === null) return;
    left.current -= shell.now() - started.current;
    stop();
  };
  return (
    <div class={`cx-toast is-${tv.kind}`} role={tv.kind === "error" ? "alert" : "status"} onPointerEnter={pause} onPointerLeave={start} onFocusCapture={pause} onBlurCapture={start}>
      {tv.kind === "change" ? (
        <span class="cx-toast-tick" aria-hidden="true">
          <Icon name="check" />
        </span>
      ) : tv.kind === "error" ? (
        <Icon name="warning" class="cx-toast-icon" />
      ) : null}
      <div class="cx-toast-body">
        <span class="cx-toast-text">{tv.text}</span>
        {tv.detail ? <span class="cx-toast-detail">{tv.detail}</span> : null}
      </div>
      {tv.undo ? (
        <TextButton
          class="cx-toast-undo"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            Promise.resolve(tv.undo?.())
              .then(() => p.onDismiss())
              .catch(() => {
                shell.toast({ kind: "error", text: pendingCopy("undoFailed"), sticky: true });
                setBusy(false);
              });
          }}
        >
          <Icon name="undo" />
          {t("toasts.undo")}
        </TextButton>
      ) : null}
      {tv.action ? (
        <TextButton class="cx-toast-action" onClick={() => tv.action?.run()}>
          {tv.action.label}
        </TextButton>
      ) : null}
      <IconButton icon="close" label={t("toasts.dismiss")} class="cx-toast-close" onClick={p.onDismiss} />
    </div>
  );
}

export function Toasts(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const sessions = useRef(0);
  const [, bump] = useState(0);
  const available = s.shared.slices.data.value.available;
  const held = heldArrivals(leaf.store.slices.ui.value, available);
  useEffect(
    () =>
      s.bus.on("runner:frame", (f) => {
        if (f.t === "event" && f.event.kind === "entries-added") {
          sessions.current += Math.max(1, f.event.conversations);
          bump((x) => x + 1);
        }
      }),
    [s],
  );
  useEffect(() => {
    if (held === 0) sessions.current = 0;
  }, [held]);
  const undo = async (id: string) => {
    await s.assistant.undo(id);
  };
  const arrivalsId = `arrivals:${available}`;
  const arrivals: ToastView | null =
    !isDesktopHost() && featureOn("liveArrivals") && held > 0 && !shell.dismissed.value.has(arrivalsId)
      ? {
          id: arrivalsId,
          kind: "arrivals",
          text: arrivalsText(held, sessions.current),
          detail: t("toasts.arrivalsWhy"),
          action: { label: t("toasts.showThem"), run: () => revealArrivals(leaf.store, available) },
          sticky: true,
          at: shell.now(),
        }
      : null;
  const views = visibleToasts(shell.toasts.value, receiptToasts(s.shared.slices.receipts.value, shell.dismissed.value, shell.openedAt, undo), arrivals);
  return (
    <div class="cx-toasts" aria-live="polite" aria-relevant="additions" data-cx-overlay="toasts">
      {views.map((v) => (
        <ToastItem key={v.id} toast={v} onDismiss={() => shell.dismissToast(v.id)} />
      ))}
    </div>
  );
}
