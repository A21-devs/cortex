/**
 * Decides WHEN the plugin asks the runner to import and organise (the runner decides WHAT). Owner: E5.
 * Created and started by the BACKGROUND tier (plugin/background.ts), not by the view, so imports happen
 * whether or not a Cortex tab is open (H2, BG-IMPORT-UNWIRED).
 *  - startup: a Claude Code + .raw/ import as soon as the background tier starts (layout ready + 30 s idle);
 *  - watch: fs.watch on the transcripts folder, debounced 60 s, imports new complete messages (staged locally
 *    for live sessions; sealed into a segment when the session is idle ≥ liveIdleMinutes or at the daily seal);
 *  - vault: a note created, changed, renamed or deleted anywhere in the vault outside wiki/ (wiki/ notes are the vault
 *    part's own live path) is imported a few seconds after the vault goes quiet, so a new note joins the figure without
 *    a restart (before, notes outside wiki/ were read only at startup);
 *  - idle: no pointer/keyboard activity in Obsidian for agents.idleStartSec (if onlyWhenIdle);
 *  - nightly at agents.nightly.hour local when enabled; "Run now" bypasses idle only;
 *  - at start and at the daily seal hour: `runSeals` and `runWeeklyStamp`, quietly, so "Sealed through <date>" stays current
 *    even on days with no import (neither depends on idle time or on the agents' caps);
 *  - never when paused, capped, the engine is unsafe/offline, settings are corrupt or the first run is not done;
 *    optionally defers background jobs while any transcript changed in the last few minutes (the user is busy
 *    in Claude Code and shares the same usage limits).
 * stop() closes every watcher and timer (called from onunload BEFORE the runner stops).
 *
 * The schedule (idle seconds, nightly hour, busy deferral) comes from the optional `schedule()` dependency so a
 * settings change applies at the next tick; without it the defaults below apply (RFC E5-2).
 */
import type { Logger } from "../shared/log";

export type ClockReason = "startup" | "watch" | "vault" | "idle" | "nightly" | "manual" | "refresh" | "seal";

export interface AgentsClock {
  start(): void;
  stop(): void;
  /** Request a run soon (after imports, "Run now", Ask refresh). */
  poke(reason: "import" | "manual" | "refresh"): void;
  readonly running: boolean;
}

/** The part of settings.agents the clock follows. */
export interface ClockSchedule {
  onlyWhenIdle: boolean;
  idleStartSec: number;
  nightly: { enabled: boolean; hour: number };
  /** Skip idle and nightly passes for this long after a transcript changed; 0 = never defer. */
  deferWhileBusyMs: number;
}

export interface AgentsClockDeps {
  now(): number;
  /** Paused, capped, first run not done, settings corrupt or engine unusable. */
  isBlocked(): boolean;
  /** Milliseconds since the last pointer/keyboard activity anywhere in Obsidian. */
  idleMs(): number;
  /** One agents pass; resolves true when it got work done (more may wait: the clock runs another at its next tick). */
  runAgents(reason: "idle" | "nightly" | "manual" | "refresh"): Promise<boolean | void>;
  runImport(reason: "startup" | "watch" | "seal" | "vault"): Promise<void>;
  /** The quiet daily settle: seal whatever no block holds yet, even when nothing was imported (the caller checks the setting). */
  runSeals?(): Promise<void>;
  /** The weekly timestamp pass under the standing consent (the caller and the runner both check the setting). */
  runWeeklyStamp?(): Promise<void>;
  /** Start watching the transcripts folder; returns a closer. */
  watchTranscripts(onChange: () => void): () => void;
  /** Start watching the vault's notes outside wiki/; returns a closer (absent: notes outside wiki/ load at startup only). */
  watchVaultNotes?(onChange: () => void): () => void;
  /** Current schedule (settings.agents); defaults apply when omitted. */
  schedule?(): ClockSchedule;
  log?: Logger;
  /** Test seams. */
  tickMs?: number;
  watchDebounceMs?: number;
  vaultDebounceMs?: number;
}

export const DEFAULT_SCHEDULE: ClockSchedule = { onlyWhenIdle: true, idleStartSec: 120, nightly: { enabled: false, hour: 3 }, deferWhileBusyMs: 0 };
export const TICK_MS = 30_000;
export const WATCH_DEBOUNCE_MS = 60_000;
/** A changed vault note is imported once the vault has been quiet this long (a save while typing comes every few seconds). */
export const VAULT_DEBOUNCE_MS = 5_000;
/** An idle pass with nothing new to look at still repeats this often (queued retries come due). */
export const IDLE_REPEAT_MS = 15 * 60_000;
/** Local hour of the daily seal when nightly runs are off. */
export const DEFAULT_SEAL_HOUR = 3;
const POKE_DELAY_MS = 1_000;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function createAgentsClock(deps: AgentsClockDeps): AgentsClock {
  const log = deps.log;
  const tickMs = deps.tickMs ?? TICK_MS;
  const debounceMs = deps.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
  const vaultDebounceMs = deps.vaultDebounceMs ?? VAULT_DEBOUNCE_MS;
  let running = false;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let pokeTimer: ReturnType<typeof setTimeout> | null = null;
  let vaultTimer: ReturnType<typeof setTimeout> | null = null;
  let closeWatch: (() => void) | null = null;
  let closeVault: (() => void) | null = null;
  let importing = false;
  /** Imports asked for while one ran: each runs once after it (a vault change never waits for the transcripts, or the other way round). */
  const importAgain = new Set<"watch" | "vault">();
  let settling = false;
  let agentsBusy = false;
  let dirty = false;
  let lastIdleRun = 0;
  let lastNightlyDay = "";
  let lastSealDay = "";
  let lastTranscriptChange = 0;

  const schedule = (): ClockSchedule => {
    try {
      return deps.schedule ? deps.schedule() : DEFAULT_SCHEDULE;
    } catch {
      return DEFAULT_SCHEDULE;
    }
  };
  const busyTranscripts = (s: ClockSchedule): boolean => s.deferWhileBusyMs > 0 && lastTranscriptChange > 0 && deps.now() - lastTranscriptChange < s.deferWhileBusyMs;

  async function importNow(reason: "startup" | "watch" | "seal" | "vault"): Promise<void> {
    if (!running) return;
    if (importing) {
      if (reason === "watch" || reason === "vault") importAgain.add(reason);
      return;
    }
    importing = true;
    try {
      await deps.runImport(reason);
      dirty = true;
    } catch (e) {
      log?.warn("import did not finish", { reason, code: (e as { code?: unknown }).code ?? "unknown" });
    } finally {
      importing = false;
    }
    const next = importAgain.has("watch") ? "watch" : importAgain.has("vault") ? "vault" : null;
    if (next && running) {
      importAgain.delete(next);
      void importNow(next);
    }
  }

  /** Seal what is unsealed, then the weekly timestamp pass. Quiet: a failure is a debug line, and the next day tries again. */
  async function settleNow(): Promise<void> {
    if (!running || settling || (!deps.runSeals && !deps.runWeeklyStamp)) return;
    settling = true;
    try {
      await deps.runSeals?.();
      await deps.runWeeklyStamp?.();
    } catch (e) {
      log?.debug("the daily seal did not finish", { code: (e as { code?: unknown }).code ?? "unknown" });
    } finally {
      settling = false;
    }
  }

  async function agentsNow(reason: "idle" | "nightly" | "manual" | "refresh"): Promise<void> {
    if (!running || agentsBusy || deps.isBlocked()) return;
    agentsBusy = true;
    let worked = false;
    try {
      worked = (await deps.runAgents(reason)) === true;
    } catch (e) {
      log?.warn("agents pass did not finish", { reason, code: (e as { code?: unknown }).code ?? "unknown" });
    } finally {
      agentsBusy = false;
      if (reason === "idle" || reason === "nightly") {
        lastIdleRun = deps.now();
        dirty = false;
      }
      // A pass takes a bounded number of jobs: one that got work done runs again at the next tick until a pass finds
      // nothing (a large backlog, like a vault's notes, is worked through in one sitting, not one pass per 15 minutes).
      if (worked) dirty = true;
    }
  }

  function tick(): void {
    if (!running) return;
    const now = deps.now();
    const s = schedule();
    const day = dayKey(now);
    const hour = new Date(now).getHours();
    const nightlyHour = s.nightly.hour >= 0 && s.nightly.hour <= 23 ? Math.floor(s.nightly.hour) : DEFAULT_SEAL_HOUR;
    // Daily seal: live sessions that never went idle become segments once a day.
    const sealHour = s.nightly.enabled ? nightlyHour : DEFAULT_SEAL_HOUR;
    if (hour >= sealHour && day !== lastSealDay) {
      lastSealDay = day;
      void importNow("seal").then(settleNow);
    }
    if (deps.isBlocked()) return;
    if (s.nightly.enabled && hour >= nightlyHour && day !== lastNightlyDay && !busyTranscripts(s)) {
      lastNightlyDay = day;
      void agentsNow("nightly");
      return;
    }
    if (agentsBusy || importing || busyTranscripts(s)) return;
    const idleEnough = !s.onlyWhenIdle || deps.idleMs() >= Math.max(0, s.idleStartSec) * 1000;
    if (idleEnough && (dirty || now - lastIdleRun >= IDLE_REPEAT_MS)) void agentsNow("idle");
  }

  function onVaultChange(): void {
    if (!running) return;
    if (vaultTimer) clearTimeout(vaultTimer);
    vaultTimer = setTimeout(() => {
      vaultTimer = null;
      void importNow("vault");
    }, vaultDebounceMs);
  }

  function onTranscriptChange(): void {
    lastTranscriptChange = deps.now();
    if (!running) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void importNow("watch");
    }, debounceMs);
  }

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      const now = deps.now();
      lastSealDay = dayKey(now);
      lastIdleRun = now;
      try {
        closeWatch = deps.watchTranscripts(onTranscriptChange);
      } catch (e) {
        log?.warn("transcript watching did not start", { code: (e as { code?: unknown }).code ?? "unknown" });
      }
      try {
        closeVault = deps.watchVaultNotes?.(onVaultChange) ?? null;
      } catch (e) {
        log?.warn("vault watching did not start", { code: (e as { code?: unknown }).code ?? "unknown" });
      }
      ticker = setInterval(tick, tickMs);
      (ticker as { unref?: () => void }).unref?.();
      void importNow("startup").then(settleNow);
    },
    stop() {
      running = false;
      if (ticker) clearInterval(ticker);
      if (debounce) clearTimeout(debounce);
      if (pokeTimer) clearTimeout(pokeTimer);
      if (vaultTimer) clearTimeout(vaultTimer);
      ticker = debounce = pokeTimer = vaultTimer = null;
      importAgain.clear();
      for (const close of [closeWatch, closeVault]) {
        try {
          close?.();
        } catch {
          // a watcher that is already closed
        }
      }
      closeWatch = closeVault = null;
    },
    poke(reason) {
      if (!running) return;
      if (reason === "import") {
        dirty = true;
        if (pokeTimer) clearTimeout(pokeTimer);
        pokeTimer = setTimeout(() => {
          pokeTimer = null;
          tick();
        }, POKE_DELAY_MS);
        return;
      }
      void agentsNow(reason);
    },
  };
}
