/**
 * Loading and progress surfaces (CORTEX-UX §8.4, §5.1 "Loading"): what the view says while the record is read.
 * Pure, so the table is testable. Owner: GAPS-UI.
 *  - View opens / cache hit: a 2 px accent progress line under the header and the stage line "Reading your record…".
 *  - Reconcile (an index already on screen): header chip "Checking for changes…"; new items are held.
 *  - First ever run (nothing indexed yet): header chip "Indexing ‹k› of ‹n›" with the progress line and the stage
 *    line "First run: Cortex is reading your vault and sessions…".
 *  - Layout in the worker: a glass pill "Arranging…" at the stage's top centre.
 *  - No WebGL2: the still picture, and the line saying so.
 */
import type { ActivityState, DataStatus } from "../state/types";
import { useServices, useShell } from "./context";
import { t } from "./copy";

export interface LoadingInputs {
  data: Pick<DataStatus, "phase" | "progress" | "available">;
  jobs: ActivityState["jobs"];
  /** The first-run step is not done yet, or the record is empty: the first-run card owns the stage. */
  firstRunCard: boolean;
  /** Stage status from the renderer. */
  stageStatus: "ok" | "context-lost" | "no-webgl" | "arranging";
}

export interface LoadingModel {
  /** 0..1 for the 2 px line, or null when nothing is loading. */
  progress: number | null;
  /** Header chip text, or null. */
  chip: string | null;
  /** Stage line text, or null. */
  stageLine: string | null;
  /** The stage line is the "Reading your record…" one (with its percentage once known): the stage shows it top-centre over a thin fill bar. */
  stageReading: boolean;
  /** The glass "Arranging…" pill. */
  arranging: boolean;
  /** The 2D fallback is showing instead of the 3D stage. */
  noWebgl: boolean;
}

/** The full first-run card shows on an empty record or before the first-run step; the sample record is a made-up record to explore, so it is never covered. */
export function firstRunCardShown(phase: string, firstRunDone: boolean, sandbox: boolean): boolean {
  return !sandbox && (phase === "empty" || !firstRunDone);
}

export function loadingModel(i: LoadingInputs): LoadingModel {
  const job = i.jobs.find((j) => j.kind === "index");
  const loading = i.data.phase === "loading" || i.data.phase === "idle" || job !== undefined;
  const shown = i.data.available > 0;
  let progress: number | null = null;
  if (job && job.total && job.total > 0) progress = Math.max(0, Math.min(1, job.done / job.total));
  else if (i.data.phase === "loading") progress = Math.max(0, Math.min(1, i.data.progress));
  let chip: string | null = null;
  if (job) {
    if (shown) chip = t("app.checking");
    else chip = job.total !== undefined ? t("app.indexing", { k: job.done.toLocaleString("en-US"), n: job.total.toLocaleString("en-US") }) : t("app.indexingNoTotal");
  } else if (i.data.phase === "loading" && shown) chip = t("app.checking");
  let stageLine: string | null = null;
  if (!i.firstRunCard && !shown && loading && i.data.phase !== "idle") stageLine = job ? t("app.firstRunLine") : progress === null ? t("app.reading") : t("app.readingPct", { p: Math.round(progress * 100) });
  let stageReading = stageLine !== null && !job;
  const noWebgl = i.stageStatus === "no-webgl";
  if (noWebgl) {
    stageLine = t("app.noWebgl");
    stageReading = false;
  }
  return { progress, chip, stageLine, stageReading, arranging: i.stageStatus === "arranging", noWebgl };
}

/**
 * Panel header underline (SYS-11): which worker request a floating panel waits on. "display", "key" and "chart" are
 * the stage's layout and colour requests (the worker re-arranges the figure: the stage status is "arranging");
 * "index" is the record being read or reconciled.
 */
export type PanelRequestKey = "display" | "key" | "chart" | "index";

/** Whether the panel's own request is in flight (pure). */
export function panelBusy(key: PanelRequestKey, i: Pick<LoadingInputs, "data" | "jobs" | "stageStatus">): boolean {
  if (key === "index") return i.data.phase === "loading" || i.jobs.some((j) => j.kind === "index");
  return i.stageStatus === "arranging";
}

/** Read-only: true while the request the panel triggered is running, so its header underline becomes a progress line. */
export function usePanelBusy(key: PanelRequestKey): boolean {
  const s = useServices();
  const shell = useShell();
  return panelBusy(key, { data: s.shared.slices.data.value, jobs: s.shared.slices.activity.value.jobs, stageStatus: shell.feed.value.status });
}

/** The header's class: the accent underline, or the indeterminate progress line while busy. */
export function panelTitleClass(busy: boolean): string {
  return busy ? "cx-popover-title is-busy" : "cx-popover-title";
}

/**
 * Desktop cold open (the splash card, desktop/renderer.ts): a centred card with the mark, the wordmark, an Open
 * button and the progress line under it. It continues by itself `SPLASH_AUTO_MS` after it is first drawn, once the
 * record is read, unless a lock or privacy blank is on: then it waits for the Open click.
 */
export const SPLASH_AUTO_MS = 1200;

export interface SplashGateInput {
  /** Milliseconds since the card was drawn. */
  shownMs: number;
  /** The vault is read and the plugin is loaded: the view could open. */
  ready: boolean;
  /** A lock (passphrase) or a privacy blank is on: only the click continues. */
  held: boolean;
  /** Open was pressed (or Enter on it). */
  opened: boolean;
}

/** "go" once the view may open, "wait" until then. */
export function splashGate(i: SplashGateInput): "wait" | "go" {
  if (!i.ready) return "wait";
  if (i.opened) return "go";
  return !i.held && i.shownMs >= SPLASH_AUTO_MS ? "go" : "wait";
}

/** Milliseconds until an auto-continue could fire (0 when it can fire now, null when only a click continues). */
export function splashAutoIn(i: Pick<SplashGateInput, "shownMs" | "held">): number | null {
  return i.held ? null : Math.max(0, SPLASH_AUTO_MS - i.shownMs);
}

/** The line under the Open button: what is being read, with the note count once it is known. */
export function splashLine(vault: string, progress?: { done: number; total: number }): string {
  return progress ? t("splash.readingNotes", { vault, done: progress.done.toLocaleString("en-US"), total: progress.total.toLocaleString("en-US") }) : t("splash.reading", { vault });
}
