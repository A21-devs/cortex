/**
 * Where the open vault key lives while Cortex runs: one slot in memory, per process, never written anywhere. Three
 * states: "plain" (the record is not encrypted; nothing to open), "locked" (the record is encrypted and no key is
 * held: writes are refused and encrypted lines read as absent) and "open" (a key is held: new data is written
 * encrypted and encrypted data reads). "Lock now", the auto-lock and quitting drop the key (the bytes are zeroed).
 * Pure TypeScript, so the lock state in the UI and the Node readers share it.
 */

export type RecordKeyState = "plain" | "locked" | "open";

/**
 * The ring lives on a well-known global slot, not in module scope: the plugin bundle and the inline runner bundle
 * (cortex-runner.js, loaded in the same process) each carry their own copy of this module and must see one key.
 */
interface RingSlot {
  held: Uint8Array | null;
  configured: boolean;
  /** While true new data is written plain although the key is held (the decrypting run: nothing new may land encrypted behind it). */
  plainWrites: boolean;
  listeners: Set<(state: RecordKeyState) => void>;
}
const SLOT = Symbol.for("cortex.record-key-ring");
function ring(): RingSlot {
  const g = globalThis as unknown as Record<symbol, RingSlot | undefined>;
  return (g[SLOT] ??= { held: null, configured: false, plainWrites: false, listeners: new Set() });
}

export function recordKeyState(): RecordKeyState {
  const r = ring();
  if (r.held) return "open";
  return r.configured ? "locked" : "plain";
}

function emit(): void {
  const s = recordKeyState();
  for (const fn of [...ring().listeners]) {
    try {
      fn(s);
    } catch {
      // a listener never stops the others
    }
  }
}

/** Tell the ring whether this record is encrypted (settings `record.encryption.enabled`). Turning it off also drops the key. */
export function setEncryptionConfigured(on: boolean): void {
  const r = ring();
  const before = recordKeyState();
  r.configured = on;
  if (!on && r.held) {
    r.held.fill(0);
    r.held = null;
  }
  if (recordKeyState() !== before) emit();
}

/** New data is written plain while the key stays held (only the "Remove encryption" run sets it). */
export function setPlainWrites(on: boolean): void {
  ring().plainWrites = on;
}

export function plainWrites(): boolean {
  return ring().plainWrites;
}

export function encryptionConfigured(): boolean {
  return ring().configured;
}

/** Hold `key` (copied): the record opens. */
export function holdVaultKey(key: Uint8Array): void {
  if (key.length !== 32) throw new Error("the vault key must be 32 bytes");
  const r = ring();
  if (r.held) r.held.fill(0);
  r.held = Uint8Array.from(key);
  emit();
}

/** Forget the key: the record locks again (when it is encrypted). */
export function dropVaultKey(): void {
  const r = ring();
  if (!r.held) return;
  r.held.fill(0);
  r.held = null;
  emit();
}

/** The key, or null while locked or plain. Callers use it at once and do not keep it. */
export function heldVaultKey(): Uint8Array | null {
  return ring().held;
}

export function subscribeKeyring(fn: (state: RecordKeyState) => void): () => void {
  const set = ring().listeners;
  set.add(fn);
  return () => set.delete(fn);
}

/** Test helper: back to a fresh, plain ring (listeners stay, and hear about it). */
export function resetKeyring(): void {
  const r = ring();
  if (r.held) r.held.fill(0);
  r.held = null;
  r.configured = false;
  r.plainWrites = false;
  emit();
}
