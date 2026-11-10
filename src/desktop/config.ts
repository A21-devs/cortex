/**
 * Cortex Desktop's launch options and the configuration the main process hands the renderer. Pure (no Electron),
 * shared by src/desktop/main.ts and src/desktop/renderer.ts.
 *
 * Command line (after `electron dist-desktop`, or `npm run desktop -- …`):
 *   --vault=<folder>      the Obsidian vault to open (default: the stored choice, else DEFAULT_VAULT_NAME in Documents)
 *   --no-background       view only: no imports, no agents, settings changes kept in memory
 *   --devtools            open the developer tools at start
 * Screenshot runs (scripts/desktop-shot.mjs passes these; the window is never shown):
 *   --shot --out=<dir> [--steps=<file.json>] [--size=1512x982] [--dpr=1] [--timeout=120000]
 *   [--settle=4500] [--device=returning|fresh] [--mode=offscreen|hidden] [--profile=<dir>]
 */
import { parseSize, StepError } from "./shotSteps";

/**
 * The vault Cortex Desktop opens when nothing else was chosen: this folder in the user's Documents (main.ts joins it
 * to Electron's documents path). When it is not a vault, the app asks for one with Choose folder.
 */
export const DEFAULT_VAULT_NAME = "Obsidian Vault";

export interface ShotOptions {
  out: string;
  steps: string | null;
  width: number;
  height: number;
  dpr: number;
  timeoutMs: number;
  settleMs: number;
  /** "returning": hints, checklist and tour already seen on this device (stable pictures); "fresh": a new device. */
  device: "returning" | "fresh";
  /**
   * "offscreen" (default): Electron's offscreen rendering at 60 frames a second, so the figure animates as on screen;
   * "hidden": a never-shown window, which Chromium paints but drives at about 1 frame a second.
   */
  mode: "hidden" | "offscreen";
  /** A throw-away browser profile folder (the harness creates and removes it). */
  profile: string | null;
}

export interface LaunchOptions {
  vault: string | null;
  viewOnly: boolean;
  devtools: boolean;
  shot: ShotOptions | null;
}

export const SHOT_DEFAULTS = { width: 1512, height: 982, dpr: 1, timeoutMs: 120_000, settleMs: 4500 } as const;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = argv.length - 1; i >= 0; i--) {
    const a = argv[i] as string;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function num(text: string | undefined, fallback: number, lo: number, hi: number, what: string): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new StepError(`--${what} must be a number between ${lo} and ${hi}`);
  return n;
}

/** Parse Electron's argv (Chromium switches are ignored). Throws StepError on a bad screenshot option. */
export function parseLaunchArgs(argv: readonly string[]): LaunchOptions {
  const vault = flagValue(argv, "vault") ?? null;
  const shotOn = hasFlag(argv, "shot");
  let shot: ShotOptions | null = null;
  if (shotOn) {
    const out = flagValue(argv, "out");
    if (!out) throw new StepError("--shot needs --out=<folder>");
    const size = parseSize(flagValue(argv, "size") ?? `${SHOT_DEFAULTS.width}x${SHOT_DEFAULTS.height}`);
    const device = flagValue(argv, "device") ?? "returning";
    if (device !== "returning" && device !== "fresh") throw new StepError("--device must be returning or fresh");
    const mode = flagValue(argv, "mode") ?? "offscreen";
    if (mode !== "hidden" && mode !== "offscreen") throw new StepError("--mode must be hidden or offscreen");
    shot = {
      out,
      steps: flagValue(argv, "steps") ?? null,
      ...size,
      dpr: num(flagValue(argv, "dpr"), SHOT_DEFAULTS.dpr, 0.5, 4, "dpr"),
      timeoutMs: num(flagValue(argv, "timeout"), SHOT_DEFAULTS.timeoutMs, 1000, 3_600_000, "timeout"),
      settleMs: num(flagValue(argv, "settle"), SHOT_DEFAULTS.settleMs, 0, 600_000, "settle"),
      device,
      mode,
      profile: flagValue(argv, "profile") ?? null,
    };
  }
  return { vault: vault && vault.trim() ? vault.trim() : null, viewOnly: shotOn || hasFlag(argv, "no-background"), devtools: hasFlag(argv, "devtools"), shot };
}

/** What the renderer gets from the main process (ipc "cortex:config"). */
export interface DesktopConfig {
  vaultRoot: string;
  vaultKey: string;
  vaultName: string;
  /** The folder of the desktop bundle (renderer.js, cortex-runner.js). */
  appDir: string;
  /** The desktop's settings folder for this vault: %APPDATA%\Cortex\vaults\<vaultKey>. */
  dataDir: string;
  /** The vault's own plugin folder, read (never written) for the first settings. */
  seedDir: string;
  /** No background tier, settings changes kept in memory. */
  viewOnly: boolean;
  /** A screenshot run: no layout restore, no vault watching, device state seeded. */
  shot: boolean;
  device: "returning" | "fresh" | null;
  /** The plugin's manifest.json (copied next to the bundle by scripts/build-desktop.mjs). */
  manifest: { id: string; name: string; version: string; minAppVersion: string; description: string; author: string; isDesktopOnly?: boolean };
  versions: { app: string; electron: string; chrome: string; node: string };
}
