/**
 * The lock card's logic (pure, so the keyboard flow is testable): which ways there are to open the lock, which step
 * the card starts on and how keys and buttons move between steps. LockOverlay.tsx draws it.
 *
 * Unlock methods are a list: a passphrase when one is set, otherwise a tap (the privacy blank). An encrypted record
 * has no blank: it lists "This Windows account" (a tap, when this computer holds a sealed key and the system can open
 * it) before the passphrase. A tap method makes the card open on its button with "Use passphrase" beside it.
 *
 *  - "choose": the record's name and one Unlock button (the first "tap" method), plus "Use passphrase" when a secret
 *    method exists. A lock with only a passphrase skips this step.
 *  - "secret": the passphrase field with Unlock. Escape or Cancel goes back to "choose" when there is one.
 *  - "rest": Cancel (or Escape with nothing to go back to) leaves the lock closed and shows only the mark; any key or a
 *    click brings the card back.
 */
import { hasPassphrase, type LockRecord } from "../../shared/lock";
import type { CopyKey } from "../copy";

export type UnlockKind = "tap" | "secret";

export interface UnlockMethod {
  id: string;
  kind: UnlockKind;
  /** Copy key of the method's own button or link. */
  label: CopyKey;
}

export type CardStep = "choose" | "secret" | "rest";

/** What decides the list: whether the record is encrypted and whether this Windows account can open it. */
export interface UnlockContext {
  /** The record is encrypted: only the key opens it (the blank lift does not exist). */
  encrypted?: boolean;
  /** This computer holds an account-sealed copy of the key and the system can open it. */
  account?: boolean;
}

/** The ways to open the lock, best first. */
export function unlockMethods(lock: Pick<LockRecord, "salt" | "hash">, ctx: UnlockContext = {}): UnlockMethod[] {
  if (ctx.encrypted) {
    const methods: UnlockMethod[] = ctx.account ? [{ id: "account", kind: "tap", label: "lock.useAccount" }] : [];
    methods.push({ id: "passphrase", kind: "secret", label: "lock.usePassphrase" });
    return methods;
  }
  return hasPassphrase(lock) ? [{ id: "passphrase", kind: "secret", label: "lock.usePassphrase" }] : [{ id: "blank", kind: "tap", label: "lock.unlock" }];
}

/** The method the "Unlock" button runs on the first step, if there is one. */
export function primaryMethod(methods: readonly UnlockMethod[]): UnlockMethod | null {
  return methods.find((m) => m.kind === "tap") ?? null;
}

/** Whether a passphrase can be typed. */
export function secretMethod(methods: readonly UnlockMethod[]): UnlockMethod | null {
  return methods.find((m) => m.kind === "secret") ?? null;
}

/** The step the card opens on. */
export function startStep(methods: readonly UnlockMethod[]): CardStep {
  return primaryMethod(methods) ? "choose" : secretMethod(methods) ? "secret" : "choose";
}

export type CardEvent = "use-secret" | "cancel" | "wake";

/** The step after a button or key. */
export function nextStep(step: CardStep, event: CardEvent, methods: readonly UnlockMethod[]): CardStep {
  switch (event) {
    case "use-secret":
      return secretMethod(methods) ? "secret" : step;
    case "cancel":
      if (step === "secret") return primaryMethod(methods) ? "choose" : "rest";
      return "rest";
    case "wake":
      return step === "rest" ? startStep(methods) : step;
  }
}

/** What a key does on the card: the next step, or null when the card does not use it. */
export function stepForKey(step: CardStep, key: string, methods: readonly UnlockMethod[]): CardStep | null {
  if (step === "rest") return key === "Tab" || key === "Shift" || key === "Control" || key === "Alt" || key === "Meta" ? null : nextStep(step, "wake", methods);
  if (key === "Escape") return nextStep(step, "cancel", methods);
  return null;
}

/** The index Tab (or Shift+Tab) moves focus to among `count` stops, wrapping; -1 when there are none. */
export function tabTarget(at: number, count: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (at < 0) return shift ? count - 1 : 0;
  return (at + (shift ? count - 1 : 1)) % count;
}
