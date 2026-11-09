/**
 * The live kill switches (SAFE-03). Owner: E2.
 * `.vault-meta/cortex/state/control.json` {paused, privacyRev} is written by the PLUGIN together with the matching
 * setting (Pause, exclusions, replies kept local, redaction). Every runner — the plugin's child and a skill-launched
 * one, which never sees the plugin's in-memory settings — re-reads it before each engine call and each import
 * unit: paused → the job stops ("stopped"); a privacyRev different from the one the job started with → the job is
 * abandoned before any further text is sent. Pause also cancels in-flight agents.run/ai.ask and tree-kills the
 * running claude.exe children (runner side, through `watchControl`).
 *
 * Fail closed: a file that cannot be read (after the usual retries for OneDrive and antivirus locks) or that is
 * not a valid v1 control state reads as PAUSED. A missing file means "never paused" (nothing was written yet).
 */
import { errCode, readTextIfExists, withFsRetry, writeJsonAtomic } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { resolveInVault, writablePath } from "../node/paths";
import type { ControlState } from "../shared/types";
import { controlPath, type StoreContext } from "./layout";

export const DEFAULT_CONTROL: ControlState = { v: 1, paused: false, privacyRev: 0, at: "1970-01-01T00:00:00.000Z" };

/** What a reader gets when the file exists but cannot be trusted. */
const FAIL_CLOSED: ControlState = { ...DEFAULT_CONTROL, paused: true };

function sanitize(raw: unknown): ControlState | null {
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1 || typeof s.paused !== "boolean" || typeof s.privacyRev !== "number" || !Number.isSafeInteger(s.privacyRev) || s.privacyRev < 0) return null;
  return { v: 1, paused: s.paused, privacyRev: s.privacyRev, at: typeof s.at === "string" ? s.at : DEFAULT_CONTROL.at };
}

/** Read the current switches. An unreadable or invalid file reads as PAUSED (fail closed). */
export async function readControl(ctx: Pick<StoreContext, "vaultRoot">): Promise<ControlState> {
  let text: string | null;
  try {
    text = await withFsRetry(() => readTextIfExists(resolveInVault(ctx.vaultRoot, controlPath())), 4);
  } catch (e) {
    return errCode(e) === "ENOENT" ? DEFAULT_CONTROL : FAIL_CLOSED;
  }
  if (text === null) return DEFAULT_CONTROL;
  try {
    return sanitize(JSON.parse(text)) ?? FAIL_CLOSED;
  } catch {
    return FAIL_CLOSED;
  }
}

/**
 * Plugin only: write the switches (bumping privacyRev when privacy changed). Pass `paused` whenever the setting is
 * known: a damaged file stays paused until a write says otherwise.
 */
export async function writeControl(ctx: StoreContext, patch: { paused?: boolean; privacyChanged?: boolean }): Promise<ControlState> {
  return withLock(locksDirOf(ctx.cacheDir), "state:control", { owner: ctx.owner, staleMs: ctx.lockStaleMs }, async () => {
    const cur = await readControl(ctx);
    const next: ControlState = {
      v: 1,
      paused: patch.paused ?? cur.paused,
      privacyRev: cur.privacyRev + (patch.privacyChanged ? 1 : 0),
      at: new Date().toISOString(),
    };
    await writeJsonAtomic(writablePath(ctx.vaultRoot, controlPath()), next);
    return next;
  });
}

export type ContinueDecision = { ok: true } | { ok: false; reason: "paused" | "privacy-changed" };

/** Runner side: should the current job continue? */
export function mayContinue(now: ControlState, startedWithRev: number): ContinueDecision {
  if (now.paused) return { ok: false, reason: "paused" };
  if (now.privacyRev !== startedWithRev) return { ok: false, reason: "privacy-changed" };
  return { ok: true };
}

export interface ControlGate {
  /** privacyRev when the job started. */
  readonly startedWithRev: number;
  /** The decision at start (a paused vault never starts a job). */
  readonly initial: ContinueDecision;
  /** Re-read control.json: call before each engine call and each import unit. */
  check(): Promise<ContinueDecision>;
}

/** Read the switches once at the start of a job and check against that start for the job's lifetime. */
export async function openControlGate(ctx: Pick<StoreContext, "vaultRoot">): Promise<ControlGate> {
  const first = await readControl(ctx);
  return {
    startedWithRev: first.privacyRev,
    initial: mayContinue(first, first.privacyRev),
    check: async () => mayContinue(await readControl(ctx), first.privacyRev),
  };
}

/**
 * Poll control.json while a job runs and call `onStop` once, as soon as it is paused or privacy changed (so the
 * runner can cancel in-flight calls and kill claude.exe at once rather than at the next unit). Returns a disposer.
 */
export function watchControl(ctx: Pick<StoreContext, "vaultRoot">, startedWithRev: number, onStop: (reason: "paused" | "privacy-changed") => void, opts: { pollMs?: number } = {}): () => void {
  let stopped = false;
  let busy = false;
  const timer = setInterval(() => {
    if (stopped || busy) return;
    busy = true;
    void readControl(ctx)
      .then((s) => {
        const d = mayContinue(s, startedWithRev);
        if (!d.ok && !stopped) {
          stopped = true;
          clearInterval(timer);
          onStop(d.reason);
        }
      })
      .catch(() => undefined) // a throwing onStop must not become an unhandled rejection
      .finally(() => {
        busy = false;
      });
  }, Math.max(250, opts.pollMs ?? 2000));
  (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
