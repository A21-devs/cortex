/**
 * Plugin settings persisted in `.obsidian/plugins/cortex/data.json` (gitignored by the vault, synced by
 * OneDrive). FROZEN CONTRACT (owner: architect). One key per row of CORTEX-UX §5.27 (General, Sources, Agents,
 * Privacy, Appearance, Advanced) plus the `you` block of §12.10. Never store secrets here.
 * The runner reads the same file (read-only) when launched from a Claude Code skill.
 *
 * NOT settings (SAFE-02): storage paths and the cache folder. Cortex's write roots are hard-coded in
 * src/node/paths.ts and src/store/layout.ts; the cache is always %LOCALAPPDATA%/cortex/<vaultKey>.
 * NOT settings either: one-time hints and the first-run checklist, which are per device
 * (`app.saveLocalStorage("cortex:hints")`, src/ui/deviceState.ts), and pinned views
 * (`.vault-meta/cortex/views.json`).
 *
 * Precedence (M12): per-view controls (Layers, Names, Lines, Dot size …) start from these globals when a leaf is
 * created and then override them for that view only; palette, stage, tint and names reach every leaf at once
 * through SettingsHandle.signal (§12.12).
 *
 * Fail-safe migration (SAFE-08): a key that is present with the wrong type falls back to the SAFE value (paused,
 * agents off, assistant replies withheld, redaction on, Apply required), not to the default; malformed
 * exclusion lists are rejected and mark the settings corrupt, which disables background work until the user
 * resolves it.
 */
import { TINT_IDS, type TintId } from "./palette";
import type { SourceKind, SpaceId } from "./types";
import { DEFAULT_CLAUDE_CODE_SPACES } from "./spaces";
import { EXT_KEYS, extDefaults, mergeExt, type SettingsExt } from "./settingsExt";

export const SETTINGS_VERSION = 8;

export type PaletteId = "prism" | "signal" | "print" | "harbor" | "orchard" | "ember" | "reef" | TintId;
export type StageId = "follow" | "ink" | "paper" | "vesper" | "lichen" | "copper" | "cobalt" | "flint" | "garnet";
/** The window themes of Settings > Appearance, in card order. The last three are dark Cortex themes (shared/palette.ts THEME_STAGES). */
export const STAGE_IDS: readonly StageId[] = ["follow", "ink", "vesper", "lichen", "copper", "cobalt", "flint", "garnet", "paper"];
/** One plan cap: stop at `pct` percent of the plan window while `on`. */
export interface PlanCapSetting {
  on: boolean;
  pct: number;
}
export type Pose = "lying" | "standing";
export type DateFormat = "d MMM yyyy" | "yyyy-MM-dd" | "MMM d, yyyy";
export type NamesMode = "off" | "hover" | "always";
export type LinesMode = "off" | "selection" | "all";
export type MotionPref = "system" | "reduced" | "full";
export type AgeColours = "hue" | "lightness";
export type ModelRole = "labels" | "summaries" | "maps" | "ask";
/** Only the Claude Code CLI is built; the other two are listed as "later" and disabled (§5.27). */
export type AgentEngineSetting = "claude-cli" | "anthropic-api" | "local" | "codex-cli" | "none";

/** The Codex CLI engine (agents/codexCli.ts): the person's own OpenAI sign-in, run headless in a read-only sandbox. */
export interface CodexEngineSettings {
  /** Absolute path to the codex executable; "" = find it on PATH. */
  path: string;
  /** A Codex model name; "" = whatever the CLI's own default is. */
  model: string;
}

/** The wire format of a local model server: Ollama's own API, or the OpenAI-compatible one (llama.cpp, LM Studio …). */
export type LocalApi = "ollama" | "openai";

export interface LocalEngineSettings {
  /** Base address of the server; loopback only unless `allowNetwork`. */
  endpoint: string;
  /** Model name as the server lists it ("" = not chosen yet). */
  model: string;
  api: LocalApi;
  /** "Allow a network address": lets the endpoint be another machine. Off, only this computer is accepted. */
  allowNetwork: boolean;
  /** Seconds a single request may take. */
  timeoutSec: number;
  /** Count local runs against the daily token cap (off: they are listed as uncounted). */
  countTowardCap: boolean;
}
/** auto = child process on the system Node, else a Node-integrated Web Worker, else inline (last resort). */
export type RunnerMode = "auto" | "child" | "worker" | "inline";
/** After labelling: Apply and show in Checks · Hold for my check (§5.27, §12.9). */
export type ReviewMode = "apply" | "hold";
/** "no-model": agents on with the rule organiser (agents.engine "none"): nothing is sent to any model. */
export type FirstRunChoice = "import-and-organise" | "import-only" | "no-model";
export type AccessLogRetention = "forever" | "1y" | "90d";
/** Which speaker is you, per folder and export (§5.27 Privacy). */
export type SpeakerChoice = "you" | "other" | "ask";

/**
 * A coding agent whose session logs sit on this computer (Codex CLI, Gemini CLI, Cursor). Off until chosen; read like
 * Claude Code: complete messages are staged at once and sealed into one segment when the session has been idle for
 * `liveIdleMinutes` or at the daily seal. Tool output stays out unless `includeToolOutput`.
 */
export interface AgentCliSetting {
  enabled: boolean;
  /** "" = the tool's usual folder in your user profile. */
  dir: string;
  watch: boolean;
  includeToolOutput: boolean;
  liveIdleMinutes: number;
}

export const AGENT_CLI_DEFAULTS: Readonly<AgentCliSetting> = { enabled: false, dir: "", watch: true, includeToolOutput: false, liveIdleMinutes: 10 };

/** The sites the live-capture add-on may read (shared/capture.ts holds their addresses). */
export type CaptureSiteId = "chatgpt" | "claude" | "gemini";

/**
 * Live capture (plugin/captureServer.ts): a receiver on 127.0.0.1 that a hand-installed browser add-on posts finished
 * chat turns to. Off until you turn it on in Sources; `consentAt` is when you read what is stored and agreed.
 * Only sites ticked in `sites` are taken, `paused` refuses everything without stopping the receiver, and the
 * per-install token lives in the local cache, never in settings.
 */
export interface CaptureSetting {
  enabled: boolean;
  paused: boolean;
  port: number;
  sites: Record<CaptureSiteId, boolean>;
  consentAt: string;
  liveIdleMinutes: number;
}

export const CAPTURE_DEFAULTS: Readonly<CaptureSetting> = { enabled: false, paused: false, port: 47831, sites: { chatgpt: false, claude: false, gemini: false }, consentAt: "", liveIdleMinutes: 10 };

export interface FolderSourceSetting {
  id: string;
  /** Absolute path of a folder the user chose (outside the vault). Text is copied into segments at import. */
  path: string;
  label: string;
  /** Lower-case extensions without a dot, e.g. ["md", "txt"]. */
  extensions: string[];
  space: SpaceId;
  watch: boolean;
  enabled: boolean;
}

export interface OffLimitsRow {
  /** Absolute path, vault path or app name. */
  path: string;
  reason: string;
}

/** `record`, `consent`, `launcher` and `captureWeb` come from settingsExt.ts (declared, defaulted and validated there). */
export interface CortexSettings extends SettingsExt {
  version: typeof SETTINGS_VERSION;
  general: {
    openOnStartup: boolean;
    pose: Pose;
    /** false until the person picks a pose; a stored "lying" from an older build then reads as Standing. */
    poseChosen: boolean;
    followActiveNote: boolean;
    /** Show generated reference notes (status: reference) and reference documents (per-view Layers override it). */
    showReference: boolean;
    dateFormat: DateFormat;
    /** 1 = Monday. */
    weekStart: 0 | 1;
    /** SAFE-11: no import or agent work runs until the first-run step is confirmed. */
    firstRunDone: boolean;
    firstRunChoice: FirstRunChoice | null;
    debug: boolean;
  };
  sources: {
    /** Off: new entries wait behind a Show them button so the view doesn't shift. */
    autoRefresh: boolean;
    vault: { enabled: boolean; excludeFolders: string[] };
    raw: {
      enabled: boolean;
      /** Folders whose documents are reference material: hidden by default, undated, never agent targets. */
      referenceFolders: string[];
      skipYaml: boolean;
      /** Skip the 8.2 MB Roblox API dump JSON. */
      skipApiDump: boolean;
      maxJsonBytes: number;
      passageWords: number;
      excludeFolders: string[];
    };
    claudeCode: {
      enabled: boolean;
      /** "" = %USERPROFILE%/.claude/projects */
      projectsDir: string;
      watch: boolean;
      includeSubagents: boolean;
      includeToolOutput: boolean;
      includeThinking: boolean;
      /**
       * Live sessions: complete messages are staged in the local cache at once (visible immediately); the vault
       * receives one immutable segment when the session has been idle this long, or at the daily seal.
       */
      liveIdleMinutes: number;
      spaceMap: Record<string, SpaceId>;
      excludeProjects: string[];
    };
    claudeAi: { enabled: boolean; includeAttachments: boolean; keepExportCopy: boolean };
    chatgpt: { enabled: boolean; includeToolOutput: boolean; includeThinking: boolean; keepExportCopy: boolean };
    gemini: { enabled: boolean; gapMinutes: number; keepExportCopy: boolean };
    /** Notion export (zip or folder of markdown and csv) and Google Docs (Takeout docx / html): read when you hand Cortex an export. */
    notion: { enabled: boolean };
    googleDocs: { enabled: boolean };
    /** Chat, notes and reading exports (importers/extra/chatExports.ts), by source kind: read when you hand Cortex the file. */
    chatExports: Record<"whatsapp" | "telegram" | "discord" | "slack" | "keep" | "evernote" | "roam" | "kindle" | "zoom", { enabled: boolean }>;
    /** Other coding agents' session logs on this computer. Off until you turn one on; tool output stays out unless you include it. */
    codexCli: AgentCliSetting;
    geminiCli: AgentCliSetting;
    cursor: AgentCliSetting;
    /** Opt-in live capture of web chat tools through a browser add-on (loopback receiver; off by default). */
    capture: CaptureSetting;
    folders: FolderSourceSetting[];
    written: { enabled: boolean };
    /** Export reminders (shared/exportDue.ts): `notify` shows one notice a day while an export is due (off by default); `cadenceDays` overrides a source's 30-day default by source id. */
    exportReminders: { notify: boolean; cadenceDays: Record<string, number> };
  };
  agents: {
    /** "Organise automatically" (set from the first-run choice). */
    enabled: boolean;
    engine: AgentEngineSetting;
    /** Absolute path to claude.exe; "" = auto (%USERPROFILE%/.local/bin/claude.exe, then PATH). */
    claudePath: string;
    paused: boolean;
    /**
     * Stop caps measured against the Claude plan: agents pause when the plan's 5-hour or weekly limit is used up to
     * `pct` percent, and resume after that window resets. Each can be turned off (`on` false). Spend in tokens and
     * dollars is only shown, never a limit.
     */
    planCaps: { fiveHour: PlanCapSetting; weekly: PlanCapSetting };
    askCountsTowardCap: boolean;
    /** Off: every data-changing action from Ask waits for Apply (include and correct_entry always do). */
    applyAskWithoutConfirm: boolean;
    onlyWhenIdle: boolean;
    idleStartSec: number;
    nightly: { enabled: boolean; hour: number };
    /** "Jobs at once", 1–4. */
    concurrency: number;
    /** CLI aliases per job role; validated against ^[a-z0-9][a-z0-9.-]{0,63}$ before use. */
    models: Record<ModelRole, string>;
    /** pack id → version; "off" disables the pack. */
    enabledPacks: Record<string, string>;
    reviewMode: ReviewMode;
    /** "Leave reference notes out of agent jobs" (on). */
    skipReference: boolean;
    perCallTimeoutSec: number;
    askTimeoutSec: number;
    /** Per-call ceiling passed to --max-budget-usd (≥ 0.01). */
    perCallMaxUsd: number;
    /** Pass --json-schema to the CLI (falls back to prompt-only JSON if the CLI rejects it). */
    useJsonSchemaFlag: boolean;
    /** The model that runs on this computer (engine "local"; agents/localEngine.ts). Nothing leaves the address below. */
    local: LocalEngineSettings;
    /** The person's own Codex CLI (engine "codex-cli"; agents/codexCli.ts). */
    codex: CodexEngineSettings;
  };
  /** Who "you" are (§12.10; edited in Settings › Privacy). */
  you: {
    names: string[];
    handles: string[];
    /** Per folder source id or export source kind. */
    speakerBySource: Record<string, SpeakerChoice>;
  };
  privacy: {
    /** "Don't send assistant replies to models from": models only see what you typed there. */
    withholdAssistantFrom: Partial<Record<SourceKind, boolean>>;
    redact: { secrets: boolean; emails: boolean; phones: boolean; /** Card numbers, bank accounts, national IDs, addresses, dates of birth (shared/personDetail.ts). */ personal: boolean; custom: string[] };
    /**
     * Personal-detail screening (shared/personDetail.ts): extra ID countries ("ca", "es", "fr", "in", "it", "nl"),
     * names to keep out (confirmed by the user, never added unasked), values the user un-screened as "kind:hash:hint"
     * rows (a salted hash, never the text) with the per-install salt, and whether the local-model pass may propose names.
     */
    screening: { idCountries: string[]; names: string[]; allowed: string[]; salt: string; localNames: boolean };
    /** SAFE-10: replace detected secrets in the vault copy and keep the original on this computer only. */
    keepSecretsLocal: boolean;
    /** Editable "Off limits" rows beyond the fixed never-read list. */
    offLimits: OffLimitsRow[];
    accessLogRetention: AccessLogRetention;
    /**
     * The Cortex lock (Cortex: Lock). `hash` is a salted PBKDF2 digest (shared/lock.ts), never the passphrase; both
     * empty = no passphrase, so the lock is a privacy blank that a click lifts. `autoLockMinutes` 0 = never.
     */
    lock: { salt: string; hash: string; iterations: number; autoLockMinutes: number };
  };
  appearance: {
    stage: StageId;
    /** null = Off; otherwise an OKLCH hue 0–359 that tints the stage lift and the haze. */
    stageTint: number | null;
    palette: PaletteId;
    ageColours: AgeColours;
    /**
     * The figure colour theme (shared/colourTheme.ts): a tint id, or null for no override. Only the render pipeline reads
     * it, to draw the figure's particles; `palette` and `ageColours` stay the person's data colours for everything else.
     * Only a tint id is ever stored; the showcase previews (never saves) a data palette here too.
     */
    figureColours: PaletteId | null;
    /**
     * Legacy: what a v6 colour theme replaced. Only the v6 and v7 migrations read it (to give an earlier version's window
     * and data colours back); nothing writes it any more.
     */
    colourMemory: { stage: StageId; palette: PaletteId; ageColours: AgeColours; stageTint: number | null };
    frosted: boolean;
    namesOnFigure: NamesMode;
    /** Region names show on the resting body (off: only over what is lit, found or pointed at). Seeds each new view's Names mode. */
    namesAtRest: boolean;
    lines: LinesMode;
    stems: boolean;
    patterns: boolean;
    motion: MotionPref;
    /** Pages swap with a short fade (off: they swap at once; the sheet still slides in the first time it opens). */
    animatePageChanges: boolean;
    /** The sheet shrinks to its edge tab when the pointer goes down on the stage. */
    collapseOnLeave: boolean;
    /** The Chart page floats as a left card over a full-width figure instead of docking on the right (wide windows only). */
    chartCard: boolean;
    /** Cortex Desktop: a slim search field at the stage's top-left, sharing its draft with the Find bar (Display › Search on the stage). */
    searchOnStage: boolean;
    dotSize: number;
    glow: number;
    brightness: number;
    stripScale: "log" | "linear";
  };
  advanced: {
    /** Absolute path to node.exe; "" = auto-detect (PATH, then common install folders). */
    nodePath: string;
    runnerMode: RunnerMode;
    maxOldSpaceMb: number;
    /**
     * Date seals: seal new entries on this computer (on by default), settled once a day as well as after imports.
     * `weeklyStamp` is a standing, revocable consent to send a fingerprint (never text) of the newest block to the named
     * timestamp calendar about once a week; `signAs` is an optional display name placed inside each signed statement.
     */
    dateSeals: { sealLocally: boolean; weeklyStamp: boolean; signAs: string };
    pointBudget: number;
    showFrameRate: boolean;
  };
}

export const DEFAULT_SETTINGS: CortexSettings = {
  ...extDefaults(),
  version: SETTINGS_VERSION,
  general: {
    openOnStartup: false,
    pose: "standing",
    poseChosen: false,
    followActiveNote: true,
    showReference: false,
    dateFormat: "d MMM yyyy",
    weekStart: 1,
    firstRunDone: false,
    firstRunChoice: null,
    debug: false,
  },
  sources: {
    autoRefresh: false,
    vault: { enabled: true, excludeFolders: ["agents/", "commands/", "hooks/", "skills/", "_templates/"] },
    raw: {
      enabled: true,
      referenceFolders: [".raw/roblox/creator-docs/"],
      skipYaml: true,
      skipApiDump: true,
      maxJsonBytes: 2 * 1024 * 1024,
      passageWords: 1200,
      excludeFolders: [],
    },
    claudeCode: {
      enabled: true,
      projectsDir: "",
      watch: true,
      includeSubagents: false,
      includeToolOutput: false,
      includeThinking: false,
      liveIdleMinutes: 10,
      spaceMap: { ...DEFAULT_CLAUDE_CODE_SPACES },
      excludeProjects: [],
    },
    claudeAi: { enabled: true, includeAttachments: true, keepExportCopy: false },
    chatgpt: { enabled: true, includeToolOutput: false, includeThinking: false, keepExportCopy: false },
    gemini: { enabled: true, gapMinutes: 30, keepExportCopy: false },
    notion: { enabled: true },
    googleDocs: { enabled: true },
    chatExports: { whatsapp: { enabled: true }, telegram: { enabled: true }, discord: { enabled: true }, slack: { enabled: true }, keep: { enabled: true }, evernote: { enabled: true }, roam: { enabled: true }, kindle: { enabled: true }, zoom: { enabled: true } },
    codexCli: { ...AGENT_CLI_DEFAULTS },
    geminiCli: { ...AGENT_CLI_DEFAULTS },
    cursor: { ...AGENT_CLI_DEFAULTS },
    capture: { ...CAPTURE_DEFAULTS, sites: { ...CAPTURE_DEFAULTS.sites } },
    folders: [],
    written: { enabled: true },
    exportReminders: { notify: false, cadenceDays: {} },
  },
  agents: {
    enabled: true,
    engine: "claude-cli",
    claudePath: "",
    paused: false,
    planCaps: { fiveHour: { on: true, pct: 70 }, weekly: { on: true, pct: 70 } },
    askCountsTowardCap: true,
    applyAskWithoutConfirm: false,
    onlyWhenIdle: false,
    idleStartSec: 60,
    nightly: { enabled: true, hour: 3 },
    concurrency: 2,
    models: { labels: "haiku", summaries: "sonnet", maps: "opus", ask: "sonnet" },
    enabledPacks: { session: "1.0.0", placement: "1.0.0", para: "off", correction: "1.0.0", resume: "off" },
    reviewMode: "apply",
    skipReference: true,
    perCallTimeoutSec: 240,
    askTimeoutSec: 90,
    perCallMaxUsd: 1,
    useJsonSchemaFlag: true,
    local: { endpoint: "http://127.0.0.1:11434", model: "", api: "ollama", allowNetwork: false, timeoutSec: 60, countTowardCap: false },
    codex: { path: "", model: "" },
  },
  you: { names: [], handles: [], speakerBySource: {} },
  privacy: {
    withholdAssistantFrom: { chatgpt: true, gemini: true, "claude-ai": false, "claude-code": false },
    redact: { secrets: true, emails: true, phones: true, personal: true, custom: [] },
    screening: { idCountries: [], names: [], allowed: [], salt: "", localNames: false },
    keepSecretsLocal: true,
    offLimits: [],
    accessLogRetention: "forever",
    lock: { salt: "", hash: "", iterations: 210_000, autoLockMinutes: 0 },
  },
  appearance: {
    stage: "follow",
    stageTint: null,
    palette: "prism",
    ageColours: "hue",
    figureColours: null,
    colourMemory: { stage: "follow", palette: "prism", ageColours: "hue", stageTint: null },
    frosted: true,
    namesOnFigure: "hover",
    namesAtRest: false,
    lines: "selection",
    stems: false,
    patterns: false,
    motion: "system",
    animatePageChanges: false,
    collapseOnLeave: true,
    chartCard: true,
    searchOnStage: true,
    dotSize: 1,
    glow: 1,
    brightness: 1,
    stripScale: "log",
  },
  advanced: { nodePath: "", runnerMode: "auto", maxOldSpaceMb: 4096, dateSeals: { sealLocally: true, weeklyStamp: false, signAs: "" }, pointBudget: 300_000, showFrameRate: false },
};

/** Ranges the settings tab clamps to (§5.27). */
export const SETTING_RANGES = {
  planCapPct: [5, 100],
  concurrency: [1, 4],
  localTimeoutSec: [10, 900],
  pointBudget: [100_000, 500_000],
  dotSize: [0.5, 2.5],
  glow: [0, 2],
  brightness: [0.25, 2],
} as const;

// ───────────────────────────── migration (fail-safe) ─────────────────────────────

export interface SettingsIssue {
  path: string;
  problem: "wrong-type" | "malformed-list" | "unreadable" | "unknown-value";
  /** What Cortex did about it. */
  action: "used-safe-value" | "used-default" | "rejected";
}

export interface MigratedSettings {
  settings: CortexSettings;
  issues: SettingsIssue[];
  /** True when a safety-relevant value could not be trusted: background work stays off and saveData is blocked. */
  corrupt: boolean;
}

/** Values used instead of the default when a safety-relevant key holds the wrong type. */
const SAFE_VALUES: Readonly<Record<string, unknown>> = {
  "agents.paused": true,
  "agents.enabled": false,
  "agents.applyAskWithoutConfirm": false,
  "agents.skipReference": true,
  "privacy.redact.secrets": true,
  "privacy.redact.emails": true,
  "privacy.redact.phones": true,
  "privacy.redact.personal": true,
  "privacy.keepSecretsLocal": true,
};
/** withholdAssistantFrom.<source> with a wrong type → true (withhold). */
const SAFE_MAP_VALUE: Readonly<Record<string, unknown>> = { "privacy.withholdAssistantFrom": true };
/** Lists that must never be coerced: a malformed value marks the settings corrupt. */
const GUARDED_LISTS = new Set(["privacy.offLimits", "sources.claudeCode.excludeProjects", "sources.vault.excludeFolders", "sources.raw.excludeFolders"]);
/** Open-ended maps whose user keys are kept. */
const OPEN_MAPS = new Set(["sources.claudeCode.spaceMap", "agents.enabledPacks", "privacy.withholdAssistantFrom", "agents.models", "you.speakerBySource", "sources.exportReminders.cadenceDays"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameShape(def: unknown, raw: unknown): boolean {
  if (Array.isArray(def)) return Array.isArray(raw);
  if (def === null) return raw === null || typeof raw === "string" || typeof raw === "number";
  return typeof raw === typeof def;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(0, i);
}

/** The safe replacement for a wrong-typed value at `path`, if the key is safety-relevant. */
function safeFor(path: string): unknown {
  return SAFE_VALUES[path] ?? SAFE_MAP_VALUE[parentOf(path)];
}

function fallback(def: unknown, path: string, issues: SettingsIssue[]): unknown {
  const safe = safeFor(path);
  issues.push({ path, problem: "wrong-type", action: safe !== undefined ? "used-safe-value" : "used-default" });
  return safe !== undefined ? safe : structuredCloneSafe(def);
}

function listIsWellFormed(path: string, raw: readonly unknown[]): boolean {
  if (path === "privacy.offLimits") return raw.every((x) => isPlainObject(x) && typeof x.path === "string" && typeof x.reason === "string");
  return raw.every((x) => typeof x === "string");
}

function mergeAt(def: unknown, raw: unknown, path: string, issues: SettingsIssue[]): unknown {
  if (raw === undefined) return structuredCloneSafe(def);
  if (isPlainObject(def)) {
    if (!isPlainObject(raw)) return fallback(def, path, issues);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(def)) out[key] = mergeAt(def[key], raw[key], path ? `${path}.${key}` : key, issues);
    if (OPEN_MAPS.has(path)) {
      // Keep the user's own keys (a project slug, a pack id …) when their values have the right type.
      const sample = Object.values(def)[0];
      for (const [k, v] of Object.entries(raw)) {
        if (Object.hasOwn(def, k)) continue;
        if (sample !== undefined && typeof v !== typeof sample) {
          const safe = SAFE_MAP_VALUE[path];
          if (safe !== undefined) {
            out[k] = safe;
            issues.push({ path: `${path}.${k}`, problem: "wrong-type", action: "used-safe-value" });
          }
          continue;
        }
        out[k] = v;
      }
    }
    return out;
  }
  if (Array.isArray(def)) {
    const guarded = GUARDED_LISTS.has(path);
    if (!Array.isArray(raw) || (guarded && !listIsWellFormed(path, raw))) {
      issues.push({ path, problem: guarded ? "malformed-list" : "wrong-type", action: guarded ? "rejected" : "used-default" });
      return structuredCloneSafe(def);
    }
    return structuredCloneSafe(raw);
  }
  if (raw === null && def !== null) return fallback(def, path, issues);
  if (!sameShape(def, raw)) return fallback(def, path, issues);
  return raw;
}

function structuredCloneSafe<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Earlier development versions → 3 (no data was ever written with them outside development). */
function upgradeOld(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const obj = (k: string): Record<string, unknown> => (isPlainObject(out[k]) ? { ...(out[k] as Record<string, unknown>) } : {});
  const general = obj("general");
  const agents = obj("agents");
  const privacy = obj("privacy");
  const appearance = obj("appearance");
  const advanced = obj("advanced");
  const you = obj("you");
  const sources = obj("sources");
  const move = (from: Record<string, unknown>, a: string, to: Record<string, unknown>, b: string, map: (v: unknown) => unknown = (v) => v) => {
    if (a in from) {
      const v = from[a];
      delete from[a];
      to[b] = map(v);
    }
  };
  move(general, "autoRefresh", sources, "autoRefresh");
  delete general.hintsSeen;
  delete general.checklist;
  move(agents, "autoOrganise", agents, "enabled");
  move(agents, "askChangesWithoutApply", agents, "applyAskWithoutConfirm");
  const oldPriv = isPlainObject(agents.privacy) ? agents.privacy : undefined;
  if (oldPriv) {
    if (isPlainObject(oldPriv.ownLinesOnly)) privacy.withholdAssistantFrom = oldPriv.ownLinesOnly;
    privacy.redact = { secrets: oldPriv.redactSecrets, emails: oldPriv.redactEmails, phones: oldPriv.redactPhones, custom: oldPriv.extraPatterns };
    delete agents.privacy;
  }
  move(privacy, "keepRepliesLocal", privacy, "withholdAssistantFrom");
  move(privacy, "keepSecretsOutOfVault", privacy, "keepSecretsLocal");
  move(privacy, "namesThatMeanYou", you, "names");
  move(privacy, "readLogRetentionDays", privacy, "accessLogRetention", (v) => (v === 90 ? "90d" : v === 365 ? "1y" : "forever"));
  delete privacy.excludedSources;
  delete privacy.excludedFolders;
  move(appearance, "names", appearance, "namesOnFigure");
  move(appearance, "conversationStems", appearance, "stems");
  move(appearance, "stageTint", appearance, "stageTint", (v) => (typeof v === "number" && v >= 0 ? v : null));
  move(appearance, "ageColours", appearance, "ageColours", (v) => (v === "single" || v === "lightness" ? "lightness" : "hue"));
  const runner = isPlainObject(out.runner) ? { ...out.runner } : {};
  move(runner, "nodePath", advanced, "nodePath");
  move(runner, "mode", advanced, "runnerMode");
  move(runner, "maxOldSpaceMb", advanced, "maxOldSpaceMb");
  delete out.runner;
  const vault = isPlainObject(sources.vault) ? sources.vault : undefined;
  if (vault && typeof vault.hideReference === "boolean") general.showReference = !vault.hideReference;
  const ai = isPlainObject(out.ai) ? out.ai : undefined;
  if (ai && typeof ai.confirmDataChanges === "boolean") agents.applyAskWithoutConfirm = !ai.confirmDataChanges;
  delete out.paths;
  delete out.ai;
  Object.assign(out, { general, agents, privacy, advanced, you, sources });
  // v1 theme and palette ids no longer exist: its appearance block is dropped, later blocks are kept.
  if (out.version === 1) delete out.appearance;
  else out.appearance = appearance;
  return out;
}

/** The window theme each colour theme set before v6 (its tint palette's id → the window theme it wrote into `appearance.stage`). */
const LEGACY_THEME_WINDOW: Readonly<Record<string, string>> = { garnet: "garnet", sapphire: "cobalt", verdant: "lichen", saffron: "copper", orchid: "vesper" };

/** Load settings from data.json content of any version, reporting what could not be trusted. */
export function migrateSettingsChecked(raw: unknown): MigratedSettings {
  const issues: SettingsIssue[] = [];
  if (raw !== null && raw !== undefined && !isPlainObject(raw)) {
    issues.push({ path: "", problem: "unreadable", action: "rejected" });
    return { settings: structuredCloneSafe(DEFAULT_SETTINGS), issues, corrupt: true };
  }
  let source: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  if (source.version === 1 || source.version === 2) source = upgradeOld(source);
  // The settingsExt.ts blocks validate themselves (typed lists, ranges, consent rules); the rest merge generically.
  const base: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of EXT_KEYS) delete base[key];
  const settings = { ...(mergeAt(base, source, "", issues) as object), ...mergeExt(source, issues) } as CortexSettings;
  // v4: Standing is the default pose; a stored pose counts only once the person has picked one.
  if (!settings.general.poseChosen) settings.general.pose = DEFAULT_SETTINGS.general.pose;
  // Names "Always" was the only way to name the resting body; it is now its own switch.
  const storedAppearance = isPlainObject(source.appearance) ? source.appearance : undefined;
  if (storedAppearance && storedAppearance.namesOnFigure === "always" && !("namesAtRest" in storedAppearance)) settings.appearance.namesAtRest = true;
  // v5: "Collapse when I leave" is on by default; before v5 a stored "off" was only the old default, so it follows the new one.
  if (typeof source.version === "number" && source.version < 5) settings.appearance.collapseOnLeave = DEFAULT_SETTINGS.appearance.collapseOnLeave;
  // v6: a colour theme recolours only the data. A window theme or tint an earlier version's colour theme set goes back to what the person had before it.
  if (typeof source.version === "number" && source.version < 6) {
    const a = settings.appearance;
    if (LEGACY_THEME_WINDOW[a.palette as string] === a.stage) {
      a.stage = a.colourMemory.stage;
      a.stageTint = a.colourMemory.stageTint;
    }
  }
  // v7: a colour theme recolours only the figure. A v6 theme had written its tint palette into the data palette (and its
  // lightness ramp into the age colours); the person's own come back from the memory and the theme moves to its own setting.
  const a7 = settings.appearance;
  if (typeof source.version === "number" && source.version < 7 && TINT_IDS.includes(a7.palette as TintId)) {
    a7.figureColours = a7.palette as TintId;
    const own = a7.colourMemory;
    a7.palette = TINT_IDS.includes(own.palette as TintId) ? DEFAULT_SETTINGS.appearance.palette : own.palette;
    a7.ageColours = own.ageColours;
  }
  if (a7.figureColours !== null && !TINT_IDS.includes(a7.figureColours as TintId)) a7.figureColours = null;
  // v7: the Chart panel floats as a card by default (the reference's table builder); a stored "off" from before v7 was only the old default.
  if (typeof source.version === "number" && source.version < 7) a7.chartCard = DEFAULT_SETTINGS.appearance.chartCard;
  // v8: the agents work whenever Cortex is open, still stopping at the plan caps. Waiting for a minute without input
  // meant they almost never ran while the app was in use; a stored "only when idle" from before v8 was only the old default.
  if (typeof source.version === "number" && source.version < 8) settings.agents.onlyWhenIdle = DEFAULT_SETTINGS.agents.onlyWhenIdle;
  settings.version = SETTINGS_VERSION;
  const corrupt = issues.some((i) => i.action === "rejected");
  if (corrupt) {
    // A distrusted file never starts background work on its own.
    settings.agents.paused = true;
    settings.agents.enabled = false;
  }
  return { settings, issues, corrupt };
}

/** Convenience for callers that only need the values. */
export function migrateSettings(raw: unknown): CortexSettings {
  return migrateSettingsChecked(raw).settings;
}

/** Model aliases are passed to argv: only short plain tokens are allowed (SAFE-05). */
export const MODEL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export function isValidModelAlias(s: string): boolean {
  return MODEL_ALIAS_PATTERN.test(s);
}
