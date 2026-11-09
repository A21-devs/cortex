/**
 * Advisory lock files in the LOCAL cache: `%LOCALAPPDATA%/cortex/<vaultKey>/locks/` (SAFE-14, LOCKS-SHARED-SYNCED).
 * Owner: E1. The plugin's runner and a skill-launched runner are on the same machine and share the vaultKey, so
 * they coordinate here; nothing is created, touched or deleted in OneDrive, and the vault's own wiki-lock folder
 * (`.vault-meta/locks/`, whose `<pid> <epoch> <path>` format Cortex does not speak) is never used.
 *
 * Lock file: `<locksDir>/<sha1(target)>.lock`, created with O_EXCL, JSON body {owner, pid, host, token, target,
 * at}. A lock whose mtime is older than `staleMs` may be broken: the breaker RENAMES it to a unique tomb name
 * (atomic, so only one breaker wins), then re-reads the tomb. If the tomb is not the stale lock it judged (the
 * holder refreshed it, or a new holder took it in between) the breaker puts it back; otherwise it deletes the
 * tomb. Release works the same way, so no process ever deletes a lock it does not hold.
 *
 * Holders refresh the mtime every staleMs/3 and verify their token before committing (`verify()`); a refresh that
 * finds another token marks the handle `lost` (after a sleep, for example) and stops refreshing. Contenders in the
 * same process queue in order instead of polling the disk. Locks are NOT re-entrant: acquiring a lock you already
 * hold waits until `waitMs` and fails with E_LOCKED. Inline (UI-thread) runners use staleMs ≥ 5 min because their
 * timers can be throttled.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import { errCode, withFsRetry } from "./fsAtomic";

export const DEFAULT_STALE_MS = 60_000;
export const INLINE_STALE_MS = 300_000;
export const DEFAULT_WAIT_MS = 10_000;

export interface LockOptions {
  /** Who holds the lock (diagnostics only), e.g. "plugin" or "runner:1234". */
  owner: string;
  staleMs?: number;
  /** How long to wait for a held lock before failing with E_LOCKED (0 = fail immediately). */
  waitMs?: number;
  pollMs?: number;
}

export interface LockHandle {
  readonly file: string;
  readonly token: string;
  /** True once a refresh or verify found that the lock no longer carries this token. */
  readonly lost: boolean;
  /** Touch the lock's mtime; returns false (and marks the handle lost) when the lock is no longer ours. */
  refresh(): Promise<boolean>;
  /** True while the lock file still carries this holder's token. */
  verify(): Promise<boolean>;
  release(): Promise<void>;
}

interface LockBody {
  owner?: unknown;
  pid?: unknown;
  host?: unknown;
  token?: unknown;
  target?: unknown;
  at?: unknown;
}

/** The lock folder for a cache folder. */
export function locksDirOf(cacheDirAbs: string): string {
  return path.join(cacheDirAbs, "locks");
}

export function lockFileName(target: string): string {
  return `${createHash("sha1").update(target).digest("hex")}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readBody(file: string): Promise<LockBody | undefined> {
  try {
    const v = JSON.parse(await fsp.readFile(file, "utf8")) as unknown;
    return typeof v === "object" && v !== null ? (v as LockBody) : undefined;
  } catch {
    return undefined;
  }
}

async function readToken(file: string): Promise<string | undefined> {
  const b = await readBody(file);
  return typeof b?.token === "string" ? b.token : undefined;
}

function tombName(file: string): string {
  return `${file}.stale-${randomBytes(6).toString("hex")}`;
}

/** Put a lock we moved by mistake back in place (only if nobody created a new lock meanwhile). */
async function restore(tomb: string, file: string): Promise<void> {
  try {
    await fsp.link(tomb, file);
  } catch {
    // A new lock exists (its holder wins), or links are unsupported: the moved lock's holder will fail verify().
  }
  await withFsRetry(() => fsp.rm(tomb, { force: true }), 3).catch(() => undefined);
}

/**
 * Break a lock that looked stale: rename it away, then confirm the tomb is the same stale lock (same token and
 * still stale). Returns true when the stale lock was removed.
 */
async function breakStale(file: string, judgedToken: string | undefined, staleMs: number): Promise<boolean> {
  const tomb = tombName(file);
  try {
    await fsp.rename(file, tomb);
  } catch {
    return false; // someone else broke or released it first
  }
  let ok = false;
  try {
    const st = await fsp.stat(tomb);
    const token = await readToken(tomb);
    ok = token === judgedToken && Date.now() - st.mtimeMs > staleMs;
  } catch {
    ok = false;
  }
  if (!ok) {
    await restore(tomb, file);
    return false;
  }
  await withFsRetry(() => fsp.rm(tomb, { force: true }), 3).catch(() => undefined);
  return true;
}

/** In-process queues per lock file: same-process contenders wait in order instead of polling. */
const localQueues = new Map<string, Promise<void>>();

function queueLocally(file: string): { ready: Promise<void>; done: () => void } {
  const prev = localQueues.get(file) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  const tail = prev.then(() => mine);
  localQueues.set(file, tail);
  void tail.then(() => {
    if (localQueues.get(file) === tail) localQueues.delete(file);
  });
  return { ready: prev, done };
}

async function waitUntil(p: Promise<void>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now()))));
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function lockedError(target: string, holder: LockBody | undefined): CortexError {
  const detail: Record<string, unknown> = { target };
  if (typeof holder?.owner === "string") detail.owner = holder.owner;
  if (typeof holder?.pid === "number") detail.pid = holder.pid;
  return new CortexError("E_LOCKED", "lock busy", { retryable: true, detail });
}

export async function acquireLock(locksDirAbs: string, target: string, opts: LockOptions): Promise<LockHandle> {
  const staleMs = Math.max(1000, opts.staleMs ?? DEFAULT_STALE_MS);
  const waitMs = Math.max(0, opts.waitMs ?? DEFAULT_WAIT_MS);
  const pollMs = Math.max(10, opts.pollMs ?? 100);
  const file = path.join(locksDirAbs, lockFileName(target));
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + waitMs;
  await withFsRetry(() => fsp.mkdir(locksDirAbs, { recursive: true }));

  const local = queueLocally(file);
  if (!(await waitUntil(local.ready, deadline))) {
    local.done();
    throw lockedError(target, await readBody(file));
  }

  const body = JSON.stringify({ owner: opts.owner, pid: process.pid, host: os.hostname(), token, target, at: new Date().toISOString() });
  try {
    for (;;) {
      try {
        const fh = await fsp.open(file, "wx");
        try {
          await fh.writeFile(body);
        } finally {
          await fh.close();
        }
        break;
      } catch (e) {
        const code = errCode(e);
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
          throw new CortexError("E_IO", "cannot create lock", { cause: e, detail: { target } });
        }
        if (code === "EEXIST") {
          let st;
          try {
            st = await fsp.stat(file);
          } catch {
            continue; // vanished between EEXIST and stat: retry at once
          }
          if (Date.now() - st.mtimeMs > staleMs) {
            const holder = await readToken(file);
            if (await breakStale(file, holder, staleMs)) continue;
          }
        }
        if (Date.now() >= deadline) throw lockedError(target, await readBody(file));
        await sleep(Math.min(pollMs * (0.5 + Math.random()), Math.max(0, deadline - Date.now())));
      }
    }
  } catch (e) {
    local.done();
    throw e;
  }

  let lost = false;
  let released = false;
  const handle: LockHandle = {
    file,
    token,
    get lost() {
      return lost;
    },
    async refresh() {
      if (released || lost) return false;
      if ((await readToken(file)) !== token) {
        lost = true;
        return false;
      }
      const now = new Date();
      await fsp.utimes(file, now, now).catch(() => undefined);
      return true;
    },
    async verify() {
      if (released) return false;
      const ok = (await readToken(file)) === token;
      if (!ok) lost = true;
      return ok;
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if ((await readToken(file)) !== token) return; // already broken as stale, or taken over
        const tomb = tombName(file);
        try {
          await withFsRetry(() => fsp.rename(file, tomb), 4);
        } catch {
          return;
        }
        if ((await readToken(tomb)) === token) await withFsRetry(() => fsp.rm(tomb, { force: true }), 4).catch(() => undefined);
        else await restore(tomb, file);
      } finally {
        local.done();
      }
    },
  };
  return handle;
}

/**
 * Run `fn` while holding the lock: refreshed every staleMs/3, verified before `fn` starts, always released.
 * `fn` receives the handle so it can `verify()` right before its commit point.
 */
export async function withLock<T>(locksDirAbs: string, target: string, opts: LockOptions, fn: (lock: LockHandle) => Promise<T>): Promise<T> {
  const lock = await acquireLock(locksDirAbs, target, opts);
  const every = Math.max(250, Math.floor(Math.max(1000, opts.staleMs ?? DEFAULT_STALE_MS) / 3));
  const timer = setInterval(() => void lock.refresh(), every);
  (timer as { unref?: () => void }).unref?.();
  try {
    if (!(await lock.verify())) throw new CortexError("E_LOCKED", "lock lost before write", { retryable: true, detail: { target } });
    return await fn(lock);
  } finally {
    clearInterval(timer);
    await lock.release();
  }
}
