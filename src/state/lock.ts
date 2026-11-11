/**
 * The Cortex lock state (P21; Cortex: Lock). One flag for the whole window: while it is set every Cortex view
 * shows LockOverlay (ui/stage/LockOverlay.tsx), the stage, sheet and command line are blanked and inert, and the
 * renderers stop (render/controller.ts). The flag is memory only: Obsidian starts unlocked, like any app that
 * is reopened, unless the record is encrypted (then both hosts start locked). Unlocking checks the passphrase kept
 * as a PBKDF2 digest in settings (shared/lock.ts); for an encrypted record unlocking opens the vault key instead
 * (shared/crypto/access.ts) and locking drops it, so "Lock now" and the auto-lock really close the record.
 */
import { signal } from "@preact/signals-core";
import { unlockRecordWithOs, unlockRecordWithPassphrase, type RecordKeyAccess, type UnlockResult } from "../shared/crypto/access";
import { dropVaultKey, encryptionConfigured, recordKeyState, subscribeKeyring } from "../shared/crypto/keyring";
import { hasPassphrase, verifyPassphrase, type LockRecord } from "../shared/lock";

export const appLocked = signal(false);

/** True while the record's key is in memory (an encrypted record is readable); false when plain or locked. */
export const recordOpen = signal(recordKeyState() === "open");
subscribeKeyring((s) => {
  recordOpen.value = s === "open";
});

export function lockApp(): void {
  appLocked.value = true;
  dropVaultKey();
}

export function unlockApp(): void {
  appLocked.value = false;
}

/** The last result of an unlock attempt with the key ("damaged": the key file cannot be read). */
export const unlockProblem = signal<"damaged" | null>(null);

/** Unlock when the passphrase fits (or none is set). Resolves to whether the lock is now open. */
export async function tryUnlock(passphrase: string, lock: LockRecord, access?: RecordKeyAccess | null): Promise<boolean> {
  if (encryptionConfigured() || recordKeyState() === "open") {
    if (!access) return false;
    const r: UnlockResult = await unlockRecordWithPassphrase(passphrase, access);
    unlockProblem.value = r === "damaged" ? "damaged" : null;
    if (r !== "ok") return false;
    unlockApp();
    return true;
  }
  if (!(await verifyPassphrase(passphrase, lock))) return false;
  unlockApp();
  return true;
}

/** Unlock an encrypted record with this Windows account's sealed key. */
export async function tryUnlockWithAccount(access: RecordKeyAccess | null | undefined): Promise<boolean> {
  if (!access) return false;
  const r = await unlockRecordWithOs(access);
  unlockProblem.value = r === "damaged" ? "damaged" : null;
  if (r !== "ok") return false;
  unlockApp();
  return true;
}

/** True when a click alone lifts the lock (no passphrase set, and the record is not encrypted). */
export function clickLifts(lock: Pick<LockRecord, "salt" | "hash">): boolean {
  return !hasPassphrase(lock) && !encryptionConfigured();
}
