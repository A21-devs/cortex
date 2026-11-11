/**
 * The shares made by the latest split, kept in memory only so the owner can show their words, save their sheets and put one
 * into a hand-over bundle. Share 1 also stays in the cache folder; the others exist nowhere else. The session ends when the
 * owner says the shares are handed out, when the record locks, and when Cortex quits (it is only a variable).
 */
import { subscribeKeyring } from "../shared/crypto/keyring";
import type { ShareSet } from "./keyShares";

let current: ShareSet | null = null;
const listeners = new Set<() => void>();
let wired = false;

function wipe(): void {
  if (!current) return;
  for (const s of current.shares) s.fill(0);
  current = null;
}

function emit(): void {
  for (const fn of [...listeners]) fn();
}

export function startShareSession(set: ShareSet): void {
  wipe();
  current = set;
  if (!wired) {
    wired = true;
    subscribeKeyring((state) => {
      if (state !== "open" && current) {
        wipe();
        emit();
      }
    });
  }
  emit();
}

export function shareSession(): ShareSet | null {
  return current;
}

export function endShareSession(): void {
  wipe();
  emit();
}

export function onShareSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
