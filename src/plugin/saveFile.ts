/**
 * Saving files the user asked for (Save image…, Copy data as CSV → file, Export diagnostics, Export file…).
 * Owner: E1 (L3; ARCHITECTURE §22 item 7). Uses the system Save dialog through Electron when the API is present
 * (feature-detected: electron.remote, then @electron/remote), defaulting to the Downloads folder; otherwise
 * writes straight to Downloads under a unique name and shows "Saved to ‹path›". Cortex never picks a location
 * inside the vault on its own; what the user chooses in the dialog is theirs. Files are written atomically
 * (temp + fsync + rename).
 */
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { CortexError, isCortexError } from "../shared/errors";
import type { LogEntry } from "../shared/log";
import type { DoctorResult } from "../shared/protocol/runner";
import { writeExternalFileAtomic } from "../node/fsAtomic";
import { t } from "../ui/copy";
import type { BackgroundServices } from "./services";

export interface SaveRequest {
  suggestedName: string;
  mime: string;
  data: Uint8Array | string;
}

export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

/** The part of Electron's dialog API Cortex uses. */
export interface SaveDialog {
  showSave(opts: { title?: string; defaultPath: string; filters: { name: string; extensions: string[] }[] }): Promise<SaveDialogResult>;
  /** The system Downloads folder, when Electron knows it. */
  downloadsDir?(): string | undefined;
}

export interface SaveDeps {
  notice(text: string): void;
  /** null = no dialog (Downloads fallback); undefined = feature-detect Electron. */
  dialog?: SaveDialog | null;
  /** Home folder for the Downloads fallback (tests). */
  home?: string;
  exists?(p: string): boolean;
  write?(p: string, data: Uint8Array | string): Promise<void>;
}

type RequireFn = (id: string) => unknown;

function nodeRequire(): RequireFn | undefined {
  const g = (globalThis as { require?: RequireFn }).require;
  if (typeof g === "function") return g;
  try {
    return typeof require === "function" ? (require as RequireFn) : undefined;
  } catch {
    return undefined;
  }
}

interface ElectronRemoteLike {
  dialog?: { showSaveDialog?: (win: unknown, opts: unknown) => Promise<SaveDialogResult> };
  getCurrentWindow?: () => unknown;
  app?: { getPath?: (name: string) => string };
}

/** Electron's Save dialog when this Obsidian exposes it, else null. Never throws. */
export function electronSaveDialog(): SaveDialog | null {
  const req = nodeRequire();
  if (!req) return null;
  let remote: ElectronRemoteLike | undefined;
  try {
    remote = (req("electron") as { remote?: ElectronRemoteLike } | undefined)?.remote;
  } catch {
    remote = undefined;
  }
  if (!remote?.dialog?.showSaveDialog) {
    try {
      remote = req("@electron/remote") as ElectronRemoteLike | undefined;
    } catch {
      remote = undefined;
    }
  }
  const show = remote?.dialog?.showSaveDialog;
  if (!remote || typeof show !== "function") return null;
  const r = remote;
  return {
    async showSave(opts) {
      let win: unknown;
      try {
        win = r.getCurrentWindow?.();
      } catch {
        win = undefined;
      }
      const res = await show.call(r.dialog, win, opts);
      return { canceled: res?.canceled === true, ...(typeof res?.filePath === "string" ? { filePath: res.filePath } : {}) };
    },
    downloadsDir() {
      try {
        const p = r.app?.getPath?.("downloads");
        return typeof p === "string" && path.isAbsolute(p) ? p : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** A file name that is safe on Windows: no path separators, reserved characters or device names. */
export function safeFileName(name: string, fallback = "cortex-export"): string {
  let s = String(name)
    .replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120);
  if (s.length === 0) s = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = `_${s}`;
  return s;
}

/** Downloads fallback path, made unique with " (2)", " (3)" … when needed. */
export function downloadsFallbackPath(name: string, exists: (p: string) => boolean, home = os.homedir(), downloads?: string): string {
  const safe = safeFileName(name);
  const dir = downloads ?? path.join(home, "Downloads");
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 2; exists(candidate) && i < 1000; i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  if (exists(candidate)) candidate = path.join(dir, `${stem} (${Date.now()})${ext}`);
  return candidate;
}

const FILTERS: Record<string, { name: string; extensions: string[] }> = {
  "image/png": { name: "PNG image", extensions: ["png"] },
  "text/csv": { name: "CSV", extensions: ["csv"] },
  "application/json": { name: "JSON", extensions: ["json"] },
  "text/markdown": { name: "Markdown", extensions: ["md"] },
  "text/plain": { name: "Text", extensions: ["txt"] },
  "application/zip": { name: "Zip archive", extensions: ["zip"] },
};

/**
 * Where a file the person asked for should go, without writing it (packs are built straight to this path by the runner):
 * the system Save dialog, else a unique name in Downloads. null when the dialog was cancelled.
 */
export async function chooseSavePath(req: { suggestedName: string; mime: string }, deps: Pick<SaveDeps, "dialog" | "home" | "exists">): Promise<string | null> {
  const name = safeFileName(req.suggestedName);
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const dialog = deps.dialog === undefined ? electronSaveDialog() : deps.dialog;
  const home = deps.home ?? os.homedir();
  const downloads = dialog?.downloadsDir?.() ?? path.join(home, "Downloads");
  if (dialog) {
    const filter = FILTERS[req.mime];
    const res = await dialog.showSave({ defaultPath: path.join(downloads, name), filters: filter ? [filter] : [] });
    if (res.canceled || !res.filePath) return null;
    if (!path.isAbsolute(res.filePath)) throw new CortexError("E_PATH_DENIED", "the chosen location is not a full path");
    return res.filePath;
  }
  const target = downloadsFallbackPath(name, exists, home, downloads);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
  } catch (e) {
    throw new CortexError("E_IO", "the Downloads folder cannot be created", { cause: e });
  }
  return target;
}

/** Save through the system dialog or the Downloads fallback; resolves to the written path or null if cancelled. */
export async function saveFile(req: SaveRequest, deps: SaveDeps): Promise<string | null> {
  const name = safeFileName(req.suggestedName);
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const write = deps.write ?? writeExternalFileAtomic;
  const dialog = deps.dialog === undefined ? electronSaveDialog() : deps.dialog;
  const home = deps.home ?? os.homedir();
  const downloads = dialog?.downloadsDir?.() ?? path.join(home, "Downloads");
  if (dialog) {
    const filter = FILTERS[req.mime];
    const res = await dialog.showSave({ defaultPath: path.join(downloads, name), filters: filter ? [filter] : [] });
    if (res.canceled || !res.filePath) return null;
    if (!path.isAbsolute(res.filePath)) throw new CortexError("E_PATH_DENIED", "the chosen location is not a full path");
    await write(res.filePath, req.data);
    return res.filePath;
  }
  const target = downloadsFallbackPath(name, exists, home, downloads);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
  } catch (e) {
    throw new CortexError("E_IO", "the Downloads folder cannot be created", { cause: e });
  }
  await write(target, req.data);
  deps.notice(t("notices.savedTo", { path: target }));
  return target;
}

// ───────────────────────────── Export diagnostics ─────────────────────────────

export interface DiagnosticsInput {
  generatedAt: string;
  cortex: { version: string; build: string };
  obsidian: { version: string };
  platform: { os: string; arch: string; release: string };
  runner: { mode: string; error?: string };
  engine: string;
  doctor: DoctorResult | null;
  lastWarning?: string;
  recent: LogEntry[];
}

/**
 * The diagnostics document (Settings › Advanced): versions, runner mode, the doctor's flags, the NAMES of the
 * environment variables passed to Claude Code (never their values), engine state and recent warnings by
 * scope and message. No record text, no settings values, no paths beyond the tools' own versions.
 */
export function buildDiagnostics(i: DiagnosticsInput): Record<string, unknown> {
  const doctor = i.doctor
    ? {
        node: i.doctor.node,
        runner: i.doctor.runner,
        build: i.doctor.build,
        claude: {
          version: i.doctor.claude.version ?? null,
          flags: i.doctor.claude.flags,
          missingMandatory: i.doctor.claude.missingMandatory,
          envKeys: [...i.doctor.claude.envKeys].sort(),
          liveCheck: i.doctor.claude.liveCheck ?? "skipped",
        },
        checks: i.doctor.checks.map((c) => ({ id: c.id, ok: c.ok })),
      }
    : null;
  return {
    kind: "cortex-diagnostics",
    v: 1,
    generatedAt: i.generatedAt,
    cortex: i.cortex,
    obsidian: i.obsidian,
    platform: i.platform,
    runner: i.runner,
    engine: i.engine,
    lastWarning: i.lastWarning ?? null,
    doctor,
    recent: i.recent.map((e) => ({ at: e.at, level: e.level, scope: e.scope, msg: e.msg })),
  };
}

/** Export diagnostics through saveFile. Resolves to the saved path, or null when the user cancelled. */
export async function exportDiagnostics(bg: BackgroundServices, deps: SaveDeps & { recent?: () => LogEntry[]; obsidianVersion?: string }): Promise<string | null> {
  let doctor: DoctorResult | null = null;
  let runnerError: string | undefined;
  try {
    doctor = await bg.runner.request({ cmd: "doctor", args: {} });
  } catch (e) {
    runnerError = isCortexError(e) ? e.code : "E_INTERNAL";
  }
  const a = bg.shared.get("activity");
  const now = new Date();
  const doc = buildDiagnostics({
    generatedAt: now.toISOString(),
    cortex: { version: bg.pluginVersion, build: __CORTEX_BUILD__ },
    obsidian: { version: deps.obsidianVersion ?? "unknown" },
    platform: { os: process.platform, arch: process.arch, release: os.release() },
    runner: { mode: bg.runner.mode, ...(runnerError !== undefined ? { error: runnerError } : {}) },
    engine: a.engine,
    doctor,
    ...(a.lastWarning !== undefined ? { lastWarning: a.lastWarning } : {}),
    recent: deps.recent?.() ?? [],
  });
  const day = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return saveFile({ suggestedName: `cortex-diagnostics-${day}.json`, mime: "application/json", data: `${JSON.stringify(doc, null, 2)}\n` }, deps);
}
