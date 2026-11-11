/**
 * Machine discovery and folder watching: cache folder, system Node, the Claude Code CLI, the transcripts
 * folder. Owner: E1. Verified on the target machine (2026-11-09): node v24.18.0 at
 * C:\Program Files\nodejs\node.exe, claude 2.1.319 at %USERPROFILE%\.local\bin\claude.exe, transcripts at
 * %USERPROFILE%\.claude\projects. Obsidian.exe has the RunAsNode fuse DISABLED, so Electron can never be used as
 * Node (no fork()); discovery only accepts executables actually named node / claude.
 */
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runProcess } from "./spawn";

export function homeDir(): string {
  return os.homedir();
}

function absOrUndefined(p: string | undefined): string | undefined {
  return p !== undefined && p.trim().length > 0 && path.isAbsolute(p.trim()) ? p.trim() : undefined;
}

/** The per-user local (never roamed, never synced) data folder of this OS. */
export function localAppData(): string {
  if (process.platform === "win32") return absOrUndefined(process.env.LOCALAPPDATA) ?? path.join(homeDir(), "AppData", "Local");
  if (process.platform === "darwin") return path.join(homeDir(), "Library", "Caches");
  return absOrUndefined(process.env.XDG_CACHE_HOME) ?? path.join(homeDir(), ".cache");
}

/**
 * %LOCALAPPDATA%/cortex/<vaultKey>. Always: the cache location is not a setting (SAFE-02), so a synced or
 * hand-edited data.json can never point cache writes (or "Clear local cache") at the vault or a user folder.
 */
export function defaultCacheDir(vaultKey: string): string {
  if (!/^[a-z2-7]{16}$/.test(vaultKey)) throw new Error("invalid vault key");
  return path.join(localAppData(), "cortex", vaultKey);
}

/** Empty working folder for headless model calls (no CLAUDE.md, no project settings nearby). */
export function agentCwd(): string {
  return path.join(localAppData(), "cortex", "agent-cwd");
}

/** The empty working folder of a headless Codex call (it holds nothing Codex would load: no AGENTS.md, no .codex). */
export function codexCwd(): string {
  return path.join(localAppData(), "cortex", "codex-cwd");
}

/**
 * Claude Code's project folder name for a working directory: every character other than an ASCII letter or
 * digit becomes "-" ("C:\a\b.c" → "C--a-b-c"). Used to find, and exclude, Cortex's own headless runs.
 */
export function claudeProjectSlug(absDir: string): string {
  return absDir.replace(/[^a-zA-Z0-9]/g, "-");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function exeName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

/**
 * True when the file name is `base` (+ ".exe" on Windows), optionally followed by a version ("node22.exe"),
 * case-insensitively. Anything else (Obsidian.exe, a shell, a script) is never launched by discovery.
 */
function namedAs(p: string, base: string): boolean {
  const name = path.basename(p).toLowerCase();
  const ext = process.platform === "win32" ? "\\.exe" : "";
  return new RegExp(`^${base}(?:[0-9][0-9.-]*)?${ext}$`).test(name);
}

/** Search PATH for an executable (Windows: the .exe only; shims such as .cmd need a shell and are skipped). */
export function whichExe(name: string): string | undefined {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  const file = process.platform === "win32" && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : name;
  for (const d of dirs) {
    const dir = d.trim().replace(/^"|"$/g, "");
    if (!path.isAbsolute(dir)) continue;
    const p = path.join(dir, file);
    if (isFile(p)) return p;
  }
  return undefined;
}

/** Existing node executables to try, the configured one first (only files actually named node / node.exe). */
export function findNodeCandidates(configured: string): string[] {
  const out: string[] = [];
  const conf = configured.trim();
  if (conf && path.isAbsolute(conf)) out.push(conf);
  const onPath = whichExe("node");
  if (onPath) out.push(onPath);
  if (process.platform === "win32") {
    out.push(path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe"));
    out.push(path.join(localAppData(), "Programs", "nodejs", "node.exe"));
    if (process.env.NVM_SYMLINK) out.push(path.join(process.env.NVM_SYMLINK, "node.exe"));
    if (process.env.VOLTA_HOME) out.push(path.join(process.env.VOLTA_HOME, "bin", "node.exe"));
    out.push(path.join(homeDir(), "scoop", "apps", "nodejs", "current", "node.exe"));
    out.push(path.join(homeDir(), "scoop", "apps", "nodejs-lts", "current", "node.exe"));
  } else {
    out.push("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node");
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return path.isAbsolute(p) && namedAs(p, "node") && isFile(p);
  });
}

export interface NodeInfo {
  path: string;
  version: string;
  major: number;
}

/** First Node ≥ minMajor that answers `--version` (spawned without a shell, with a minimal environment). */
export async function findNode(configured: string, minMajor = 20): Promise<NodeInfo | undefined> {
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  for (const p of findNodeCandidates(configured)) {
    try {
      const r = await runProcess(p, ["--version"], { cwd: os.tmpdir(), timeoutMs: 5000, env, maxStdoutBytes: 4096 });
      const v = r.stdout.trim();
      const m = /^v(\d+)\.\d+\.\d+/.exec(v);
      if (r.code === 0 && m && Number(m[1]) >= minMajor) return { path: p, version: v, major: Number(m[1]) };
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Existing claude executables to try, the configured one first (only files named claude / claude.exe). */
export function findClaudeCandidates(configured: string): string[] {
  const out: string[] = [];
  const conf = configured.trim();
  if (conf && path.isAbsolute(conf)) out.push(conf);
  out.push(path.join(homeDir(), ".local", "bin", exeName("claude")));
  const onPath = whichExe("claude");
  if (onPath) out.push(onPath);
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return namedAs(p, "claude") && isFile(p);
  });
}

/**
 * Existing codex executables to try, the configured one first (only files named codex / codex.exe). On Windows only a
 * real .exe can be launched without a shell, so the npm `codex.cmd` shim is never offered: point Settings at codex.exe.
 */
export function findCodexCandidates(configured: string): string[] {
  const out: string[] = [];
  const conf = configured.trim();
  if (conf && path.isAbsolute(conf)) out.push(conf);
  out.push(path.join(homeDir(), ".local", "bin", exeName("codex")));
  const onPath = whichExe("codex");
  if (onPath) out.push(onPath);
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return namedAs(p, "codex") && isFile(p);
  });
}

/** The Claude Code transcripts folder ("" = %USERPROFILE%/.claude/projects; a relative setting is ignored). */
export function claudeProjectsDir(configured: string): string {
  const conf = configured.trim();
  return conf && path.isAbsolute(conf) ? conf : path.join(homeDir(), ".claude", "projects");
}

export function pathExists(p: string): boolean {
  return existsSync(p);
}

export interface WatchOptions {
  /** Only changes to file names accepted by this filter count (relative to the watched folder, "/" separated). */
  filter?: (relPath: string) => boolean;
  /** Coalesce bursts: `onChange` runs once, this long after the first change of a burst (default 1000 ms). */
  debounceMs?: number;
  /** Called once when the watcher fails (folder deleted, permissions); the watcher is closed by then. */
  onError?: (e: unknown) => void;
}

/**
 * Watch a folder tree (recursive) and call `onChange` after changes settle. Returns a closer; a missing or
 * unreadable folder yields a closer that does nothing (and onError is called once). Never throws.
 */
export function watchTree(dirAbs: string, onChange: () => void, opts: WatchOptions = {}): () => void {
  const debounceMs = Math.max(0, opts.debounceMs ?? 1000);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let watcher: FSWatcher | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      watcher?.close();
    } catch {
      // already closed
    }
    watcher = null;
  };
  const fire = (): void => {
    timer = null;
    if (closed) return;
    try {
      onChange();
    } catch (e) {
      opts.onError?.(e);
    }
  };
  try {
    watcher = watch(dirAbs, { recursive: true, persistent: false }, (_event, name) => {
      if (closed) return;
      const rel = typeof name === "string" ? name.split(path.sep).join("/") : "";
      if (opts.filter && rel !== "" && !opts.filter(rel)) return;
      if (timer === null) timer = setTimeout(fire, debounceMs);
    });
    watcher.on("error", (e) => {
      close();
      opts.onError?.(e);
    });
  } catch (e) {
    close();
    opts.onError?.(e);
  }
  return close;
}

// ───────────────────────────── other coding agents' folders ─────────────────────────────

function absEnv(name: string): string | undefined {
  return absOrUndefined(process.env[name]);
}

/** Codex CLI's home (`CODEX_HOME`, else `~/.codex`); its sessions are under `sessions/`. */
export function codexHomeDir(): string {
  return absEnv("CODEX_HOME") ?? path.join(homeDir(), ".codex");
}

/** Gemini CLI's folder (`$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`); its history is under `tmp/<project hash>/`. */
export function geminiCliHomeDir(): string {
  const env = absEnv("GEMINI_CLI_HOME");
  return env !== undefined ? path.join(env, ".gemini") : path.join(homeDir(), ".gemini");
}

/** Cursor's user folder; its chats are in the `state.vscdb` files under `globalStorage` and `workspaceStorage`. */
export function cursorUserDir(): string {
  if (process.platform === "win32") return path.join(absEnv("APPDATA") ?? path.join(homeDir(), "AppData", "Roaming"), "Cursor", "User");
  if (process.platform === "darwin") return path.join(homeDir(), "Library", "Application Support", "Cursor", "User");
  return path.join(absEnv("XDG_CONFIG_HOME") ?? path.join(homeDir(), ".config"), "Cursor", "User");
}
