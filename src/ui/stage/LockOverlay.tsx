/**
 * The lock screen (Cortex: Lock; P21). Covers every Cortex view while `appLocked` is set: the root takes the
 * class `is-locked`, which hides everything but this overlay (stage, sheet, rail, command line and tour), and the
 * renderers stop (render/controller.ts). It is a centred card sharing the splash's look (the mark, the wordmark, the
 * record's name): an Unlock button, "Use passphrase" and Cancel. The ways to open are a list (lockCard.ts): with a
 * passphrase set the card asks for it (a wrong one is refused, and the next try waits one second); with none, the
 * lock is a privacy blank and Unlock, a click or Enter lifts it. Cancel leaves the lock closed and shows only the mark.
 * All key and pointer events stop here, so nothing behind it can react.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { encryptionConfigured } from "../../shared/crypto/keyring";
import { appLocked, tryUnlock, tryUnlockWithAccount, unlockApp, unlockProblem } from "../../state/lock";
import { useServices } from "../context";
import { t } from "../copy";
import { CORTEX_GLYPH_PATHS } from "../icons";
import { useRailPalette } from "../nav/RailWordmark";
import { nextStep, primaryMethod, secretMethod, startStep, stepForKey, tabTarget, unlockMethods, type CardStep } from "./lockCard";

/** Seconds a wrong passphrase makes the person wait before the next try. */
export const WRONG_DELAY_MS = 1000;

/** The record's name: the vault's, or the product's name when Obsidian does not say. */
function recordName(s: ReturnType<typeof useServices>): string {
  try {
    const n = s.app.vault.getName();
    if (n) return n;
  } catch {
    // no vault name in this host
  }
  return t("app.name");
}

export function LockOverlay(): JSX.Element | null {
  const s = useServices();
  const rp = useRailPalette();
  const locked = appLocked.value;
  const lock = s.settings.value.privacy.lock;
  const encrypted = encryptionConfigured();
  const [account, setAccount] = useState(false);
  const methods = unlockMethods(lock, { encrypted, account });
  const primary = primaryMethod(methods);
  const secret = secretMethod(methods);
  const needsPassphrase = secret !== null && primary === null;
  const [step, setStep] = useState<CardStep>(startStep(methods));
  const [text, setText] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const first = startStep(methods);

  // "This Windows account" is offered only when this computer holds a sealed key and the system can open it.
  useEffect(() => {
    let live = true;
    if (locked && encrypted && s.recordKeys) void s.recordKeys.osReady().then((ok) => live && setAccount(ok), () => undefined);
    return () => {
      live = false;
    };
  }, [locked, encrypted, s]);

  useEffect(() => {
    setStep(first);
    if (!locked) {
      setText("");
      setWrong(false);
    }
  }, [locked, first]);

  // Focus follows the step: the field, the Unlock button, or the card itself when only the mark shows.
  useEffect(() => {
    if (!locked) return;
    if (step === "secret") field.current?.focus();
    else if (step === "choose") button.current?.focus();
    else root.current?.focus();
  }, [locked, step]);

  if (!locked) return null;

  const go = (event: "use-secret" | "cancel" | "wake"): void => {
    const next = nextStep(step, event, methods);
    if (next !== step) {
      if (next !== "secret") setText("");
      setWrong(false);
      setStep(next);
    }
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    if (step === "choose" && primary?.id !== "account") return unlockApp();
    setBusy(true);
    const ok = step === "choose" ? await tryUnlockWithAccount(s.recordKeys) : await tryUnlock(text, lock, s.recordKeys);
    if (ok) {
      setText("");
      setWrong(false);
      setBusy(false);
      return;
    }
    setWrong(true);
    setText("");
    setTimeout(() => {
      setBusy(false);
      // The field was disabled for the wait and lost focus: put the caret back so the next try can be typed.
      setTimeout(() => field.current?.focus(), 0);
    }, WRONG_DELAY_MS);
  };

  const trap = (e: Event): void => e.stopPropagation();
  const onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === "Tab") {
      // Keep focus inside the card: its own buttons and field, wrapping.
      const stops = Array.from(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
      e.preventDefault();
      if (step === "rest") return;
      stops[tabTarget(stops.indexOf(document.activeElement as HTMLElement), stops.length, e.shiftKey)]?.focus();
      return;
    }
    const to = stepForKey(step, e.key, methods);
    if (to !== null && to !== step) {
      e.preventDefault();
      go(step === "rest" ? "wake" : "cancel");
    }
  };

  const gradient = { background: rp.gradient };
  const resting = step === "rest";
  const blankClick = step === "choose" && primary?.id === "blank";
  return (
    <div
      ref={root}
      class={`cx-lock${needsPassphrase ? "" : " is-blank"}${resting ? " is-resting" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("lock.title")}
      tabIndex={-1}
      onKeyDown={onKey}
      onKeyUp={trap}
      onWheel={trap}
      onContextMenu={(e) => e.preventDefault()}
      onClick={resting ? () => go("wake") : blankClick ? () => unlockApp() : undefined}
    >
      <div class="cx-lock-card" onClick={(e) => e.stopPropagation()}>
        <svg class="cx-lock-mark" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d={CORTEX_GLYPH_PATHS.outer} />
          <path d={CORTEX_GLYPH_PATHS.inner} />
          <circle cx={CORTEX_GLYPH_PATHS.seed.cx} cy={CORTEX_GLYPH_PATHS.seed.cy} r={CORTEX_GLYPH_PATHS.seed.r} fill="currentColor" stroke="none" />
        </svg>
        <p class="cx-lock-word">{t("rail.wordmark")}</p>
        {resting ? (
          <p class="cx-lock-note">{t("lock.rest")}</p>
        ) : (
          <>
            <p class="cx-lock-record">{recordName(s)}</p>
            <h2 class="cx-lock-title">{t("lock.title")}</h2>
            {step === "secret" ? (
              <form
                class="cx-lock-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <label class="cx-lock-field">
                  <span>{t("lock.passphrase")}</span>
                  <input ref={field} type="password" class="cx-input" autocomplete="off" value={text} maxLength={256} disabled={busy} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
                </label>
                <button ref={button} type="submit" class="cx-lock-button" style={gradient} disabled={busy || text.length === 0}>
                  {t("lock.unlock")}
                </button>
                <p class="cx-lock-note" role="alert">
                  {wrong ? t(unlockProblem.value === "damaged" ? "lock.damaged" : "lock.wrong") : ""}
                </p>
                <button type="button" class="cx-lock-link" onClick={() => go("cancel")}>
                  {t("lock.cancel")}
                </button>
              </form>
            ) : (
              <>
                <p class="cx-lock-note">{encrypted ? t("lock.encrypted") : t("lock.blank")}</p>
                <button ref={button} type="button" class="cx-lock-button" style={gradient} disabled={busy} onClick={() => void submit()}>
                  {t(primary?.label ?? "lock.unlock")}
                </button>
                {wrong && step === "choose" ? (
                  <p class="cx-lock-note" role="alert">
                    {t(unlockProblem.value === "damaged" ? "lock.damaged" : "lock.accountFailed")}
                  </p>
                ) : null}
                <div class="cx-lock-links">
                  {secret ? (
                    <button type="button" class="cx-lock-link" onClick={() => go("use-secret")}>
                      {t(secret.label)}
                    </button>
                  ) : null}
                  <button type="button" class="cx-lock-link" onClick={() => go("cancel")}>
                    {t("lock.cancel")}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
