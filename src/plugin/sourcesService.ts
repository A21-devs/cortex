/**
 * Sources page, Add sources and the first-run step (CORTEX-UX §5.22, §5.26, §12.13). Owner: E3.
 *
 * Reads `.vault-meta/cortex/sources.json` (SourceManifest), the machine-local document states and the list of
 * files that are only OneDrive placeholders; acts only through the runner (import, import.inspect,
 * import.estimate), settings and corrections (Remove source… = stop watching + leave out everything the source
 * imported; nothing is deleted). `estimate()` is a dry run that lists directories and file sizes only, so the
 * first-run step can show counts and the backlog before anything is imported or sent (SAFE-11). Paths in rows
 * are vault folders built by Cortex, never raw error text (SAFE-17).
 *
 * Row ids: "vault", "raw", "claude-code", "claude-ai", "chatgpt", "gemini", "written", "folder:<id>".
 */
import type { App } from "obsidian";
import * as path from "node:path";
import { promises as fsp } from "node:fs";
import { CHAT_EXPORT_KEYS, isChatExportKey } from "../shared/chatExportKinds";
import { CortexError } from "../shared/errors";
import { ItemFlag, Population, SOURCE_ORDER, SPEAKER_ORDER, type DataIndex } from "../shared/index-format";
import type { Logger } from "../shared/log";
import type { EstimateResult, SourceSelector, WarningCode } from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import type { SourceKind, SourceManifest } from "../shared/types";
import { errCode, readJsonIfExists, writeJsonAtomic } from "../node/fsAtomic";
import { claudeProjectsDir, pathExists } from "../node/platform";
import { cacheWritablePath, resolveInVault } from "../node/paths";
import { cacheLayout } from "../store/layout";
import { loadSourceManifest } from "../store/manifest";
import type { DocStateFile, NotLocalFile } from "../importers/common";
import type { SourcesServiceExt } from "../ui/modals/AddSourcesModal";
import type { CorrectionService } from "./corrections";
import type { RunnerClient } from "./runnerClient";
import type { SaveRequest } from "./saveFile";
import type { AttentionRow, FileRow, SettingsHandle, SourceRow, SourcesService } from "./services";

/** Rough tokens to label and summarise one note (the same figure as importers/registry.ts TOKENS_PER_NOTE). */
const TOKENS_PER_NOTE = 1100;
const MAX_FILE_ROWS = 5000;
const FETCH_TIMEOUT_MS = 20_000;

export interface SourcesDeps {
  app: App;
  vaultRoot: string;
  cacheDir: string;
  log: Logger;
  settings: SettingsHandle;
  runner: Pick<RunnerClient, "request">;
  corrections: Pick<CorrectionService, "exclude">;
  /** The loaded record index (for the "your words" share); null while it builds. */
  index?: () => DataIndex | null;
  /** An import pass is running (the activity tracker). */
  importing?: () => boolean;
  /** The sample record is showing (M13): importing and removing refuse. */
  sandbox?: () => boolean;
  /** Save a file the user asked for (plugin/saveFile.ts, with its dialog). */
  save?: (req: SaveRequest) => Promise<string | null>;
  /** Health of the index and the background program (shared state), for the system rows of Needs attention (CORTEX-UX 5.31). */
  health?: () => { indexFailure?: "last-good" | "none"; runner?: string };
  now?: () => number;
}

const STORED_IN: Record<string, string> = {
  vault: ".raw/chats/obsidian/",
  raw: ".raw/ (read in place)",
  "claude-code": ".raw/chats/claude-code/",
  "claude-ai": ".raw/chats/claude-ai/",
  chatgpt: ".raw/chats/chatgpt/",
  gemini: ".raw/chats/gemini/",
  written: ".raw/written/",
  notion: ".raw/chats/notion/",
  "google-docs": ".raw/chats/google-docs/",
  whatsapp: ".raw/chats/whatsapp/",
  telegram: ".raw/chats/telegram/",
  discord: ".raw/chats/discord/",
  slack: ".raw/chats/slack/",
  keep: ".raw/chats/keep/",
  evernote: ".raw/chats/evernote/",
  roam: ".raw/chats/roam/",
  kindle: ".raw/chats/kindle/",
  zoom: ".raw/chats/zoom/",
  "codex-cli": ".raw/chats/codex-cli/",
  "gemini-cli": ".raw/chats/gemini-cli/",
  cursor: ".raw/chats/cursor/",
  capture: ".raw/chats/capture/",
};

const FIXED_ROWS: readonly { id: string; kind: SourceKind }[] = [
  { id: "vault", kind: "obsidian" },
  { id: "raw", kind: "files" },
  { id: "claude-code", kind: "claude-code" },
  { id: "claude-ai", kind: "claude-ai" },
  { id: "chatgpt", kind: "chatgpt" },
  { id: "gemini", kind: "gemini" },
  { id: "written", kind: "written" },
];

/**
 * Rows that appear once the source is on or has imported something: notes exports and other coding agents.
 * The agents are opt-in (settings.sources.<key>.enabled, off by default) and have a watch switch like Claude Code.
 */
const OPTIONAL_ROWS: readonly { id: string; kind: SourceKind }[] = [
  { id: "notion", kind: "notion" },
  { id: "google-docs", kind: "google-docs" },
  ...CHAT_EXPORT_KEYS.map((k) => ({ id: k, kind: k }) as const),
  { id: "codex-cli", kind: "codex-cli" },
  { id: "gemini-cli", kind: "gemini-cli" },
  { id: "cursor", kind: "cursor" },
  { id: "capture", kind: "capture" },
];
const AGENT_KEYS = { "codex-cli": "codexCli", "gemini-cli": "geminiCli", cursor: "cursor" } as const;
const agentKeyOf = (id: string): (typeof AGENT_KEYS)[keyof typeof AGENT_KEYS] | undefined => (Object.hasOwn(AGENT_KEYS, id) ? AGENT_KEYS[id as keyof typeof AGENT_KEYS] : undefined);

/** An export is recorded per file (`<kind>:<hash>`); the row of its source adds them up. */
function manifestOfKind(manifest: SourceManifest, kind: SourceKind): SourceManifest["sources"][string] | undefined {
  const rows = Object.values(manifest.sources).filter((r) => r.kind === kind);
  const latest = [...rows].sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0];
  if (!latest) return undefined;
  return { ...latest, entries: rows.reduce((n, r) => n + r.entries, 0), conversations: rows.reduce((n, r) => n + r.conversations, 0), status: rows.some((r) => r.status === "error") ? "error" : latest.status };
}

function electron(): { shell?: { openPath?(p: string): Promise<string> } } | null {
  try {
    const req = (globalThis as { require?: (m: string) => unknown }).require;
    return req ? (req("electron") as { shell?: { openPath?(p: string): Promise<string> } }) : null;
  } catch {
    return null;
  }
}

/** Fold a record index into "share of words that are yours" per source kind (reference and left-out items excluded). */
export function yourShareBySource(index: DataIndex | null): Map<SourceKind, number> {
  const out = new Map<SourceKind, number>();
  if (!index) return out;
  const c = index.cols;
  const words = new Map<SourceKind, { all: number; mine: number }>();
  for (let i = 0; i < index.count; i++) {
    if (c.kind[i] !== 0 && c.kind[i] !== 1 && c.kind[i] !== 2 && c.kind[i] !== 3) continue;
    if (((c.flags[i] ?? 0) & (ItemFlag.Reference | ItemFlag.Excluded)) !== 0) continue;
    const src = SOURCE_ORDER[c.source[i] ?? 0];
    if (!src) continue;
    const w = c.words[i] ?? 0;
    const slot = words.get(src) ?? { all: 0, mine: 0 };
    slot.all += w;
    if (SPEAKER_ORDER[c.speaker[i] ?? 0] === "you") slot.mine += w;
    words.set(src, slot);
  }
  for (const [k, v] of words) out.set(k, v.all > 0 ? v.mine / v.all : 0);
  return out;
}

/**
 * The Sources rows of the sample record (M13): counts and shares come from the loaded sample index alone. The
 * manifest, the ledger and the person's settings are never read, so the sample shows the sample's sources.
 * Claude Code and the export sources count conversations; the others count entries (notes for the vault row).
 */
export function sampleSourceRows(index: DataIndex | null): SourceRow[] {
  const share = yourShareBySource(index);
  const convs = new Map<SourceKind, number>();
  const entries = new Map<SourceKind, number>();
  const newest = new Map<SourceKind, number>();
  if (index) {
    for (let r = 0; r < index.convs.size; r++) {
      const k = index.convs.get(r).source;
      convs.set(k, (convs.get(k) ?? 0) + 1);
    }
    for (let o = 0; o < index.count; o++) {
      if (((index.cols.flags[o] ?? 0) & ItemFlag.Excluded) !== 0) continue;
      const k = SOURCE_ORDER[index.cols.source[o] ?? 0];
      if (!k) continue;
      const wantNote = k === "obsidian";
      if ((index.cols.pop[o] === Population.Note) !== wantNote) continue;
      entries.set(k, (entries.get(k) ?? 0) + 1);
      const added = index.cols.tAdded[o] ?? Number.NaN;
      if (Number.isFinite(added) && added > (newest.get(k) ?? 0)) newest.set(k, added);
    }
  }
  return FIXED_ROWS.map((fixed) => {
    const perConversation = fixed.id === "claude-code" || fixed.id === "claude-ai" || fixed.id === "chatgpt" || fixed.id === "gemini";
    const items = perConversation ? (convs.get(fixed.kind) ?? 0) : (entries.get(fixed.kind) ?? 0);
    return { id: fixed.id, kind: fixed.kind, status: items > 0 ? "imported" : "not-added", items, yourShare: share.get(fixed.kind) ?? 0, storedIn: STORED_IN[fixed.id] ?? "", watching: false, ...(newest.has(fixed.kind) ? { lastImport: new Date(newest.get(fixed.kind) as number).toISOString() } : {}) } satisfies SourceRow;
  });
}

function docStateFile(cacheDir: string, name: string): string {
  return path.join(cacheLayout(cacheDir).state, `docs-${name}.json`);
}

export function createSourcesService(deps?: SourcesDeps): SourcesServiceExt {
  const need = (): SourcesDeps => {
    if (!deps) throw new CortexError("E_INTERNAL", "Sources is not connected to the vault");
    return deps;
  };
  const now = (): number => (deps?.now ?? Date.now)();
  const notSample = (d: SourcesDeps): void => {
    if (d.sandbox?.()) throw new CortexError("E_BAD_REQUEST", "the sample record is showing; nothing is imported or changed");
  };

  async function states(d: SourcesDeps): Promise<{ name: string; file: DocStateFile }[]> {
    const names = ["raw", "written", ...d.settings.value.sources.folders.map((f) => `folder-${f.id}`)];
    const out: { name: string; file: DocStateFile }[] = [];
    for (const name of names) {
      const f = await readJsonIfExists<DocStateFile>(docStateFile(d.cacheDir, name)).catch(() => null);
      if (f && f.v === 1 && f.files) out.push({ name, file: f });
    }
    return out;
  }

  async function notLocal(d: SourcesDeps): Promise<string[]> {
    const f = await readJsonIfExists<NotLocalFile>(path.join(cacheLayout(d.cacheDir).state, "not-local.json")).catch(() => null);
    return f && f.v === 1 && f.bySource ? Object.values(f.bySource).flat() : [];
  }

  /** Notes in the vault (Obsidian's index: wiki notes and your own) and how many of them are reference notes. */
  function vaultCounts(d: SourcesDeps): { notes: number; reference: number } {
    const md = d.app.vault.getMarkdownFiles();
    let reference = 0;
    for (const f of md) if (d.app.metadataCache.getFileCache(f)?.frontmatter?.status === "reference") reference++;
    return { notes: md.length, reference };
  }

  function selectorsOf(s: CortexSettings): SourceSelector[] {
    const sels: SourceSelector[] = [];
    if (s.sources.claudeCode.enabled) sels.push({ kind: "claude-code" });
    if (s.sources.raw.enabled) sels.push({ kind: "raw" });
    if (s.sources.vault.enabled) sels.push({ kind: "vault-notes" });
    if (s.sources.codexCli.enabled) sels.push({ kind: "codex-cli" });
    if (s.sources.geminiCli.enabled) sels.push({ kind: "gemini-cli" });
    if (s.sources.cursor.enabled) sels.push({ kind: "cursor" });
    for (const f of s.sources.folders) if (f.enabled) sels.push({ kind: "folder", id: f.id });
    return sels;
  }

  return {
    listFolderFiles: (root, extensions) => listFolderFiles(root, extensions),
    saveFolderSpeakers: (folderId, files) => saveFolderSpeakers(need().cacheDir, folderId, files),
    async list() {
      const d = need();
      if (d.sandbox?.()) return sampleSourceRows(d.index?.() ?? null);
      const s = d.settings.value;
      const manifest: SourceManifest = await loadSourceManifest(d);
      const share = yourShareBySource(d.index?.() ?? null);
      const importing = d.importing?.() === true;
      const rows: SourceRow[] = [];
      const enabled = (id: string): boolean => {
        switch (id) {
          case "vault":
            return s.sources.vault.enabled;
          case "raw":
            return s.sources.raw.enabled;
          case "claude-code":
            return s.sources.claudeCode.enabled;
          case "claude-ai":
            return s.sources.claudeAi.enabled;
          case "chatgpt":
            return s.sources.chatgpt.enabled;
          case "gemini":
            return s.sources.gemini.enabled;
          default:
            return s.sources.written.enabled;
        }
      };
      for (const fixed of FIXED_ROWS) {
        const m = manifest.sources[fixed.id];
        const exportOnly = fixed.id === "claude-ai" || fixed.id === "chatgpt" || fixed.id === "gemini";
        const on = enabled(fixed.id);
        const watching = fixed.id === "claude-code" ? on && s.sources.claudeCode.watch : fixed.id === "vault" || fixed.id === "raw" || fixed.id === "written" ? on : false;
        let status: SourceRow["status"];
        if (importing && on) status = "importing";
        else if (m?.status === "error" || m?.status === "changed") status = "attention";
        else if (m === undefined && (exportOnly || !on)) status = "not-added";
        else if (watching) status = "watching";
        else if (m === undefined) status = "connected";
        else status = "imported";
        const yours = fixed.id === "raw" ? (s.you.speakerBySource.raw === "you" ? 1 : 0) : (share.get(fixed.kind) ?? 0);
        const row: SourceRow = {
          id: fixed.id,
          kind: fixed.kind,
          status,
          items: fixed.id === "claude-code" || exportOnly ? (m?.conversations ?? 0) : (m?.entries ?? 0),
          yourShare: yours,
          storedIn: STORED_IN[fixed.id] ?? "",
          watching,
        };
        if (m?.importedAt) row.lastImport = m.importedAt;
        rows.push(row);
      }
      for (const opt of OPTIONAL_ROWS) {
        const m = manifest.sources[opt.id] ?? (isChatExportKey(opt.id) ? manifestOfKind(manifest, opt.kind) : undefined);
        const key = agentKeyOf(opt.id);
        const cap = opt.id === "capture" ? s.sources.capture : undefined;
        const agent = key ? s.sources[key] : cap ? { enabled: cap.enabled, watch: !cap.paused } : undefined;
        if (m === undefined && !agent?.enabled) continue;
        const on = agent ? agent.enabled : true;
        const watching = agent ? agent.enabled && agent.watch : false;
        let status: SourceRow["status"];
        if (importing && agent?.enabled) status = "importing";
        else if (m?.status === "error" || m?.status === "changed") status = "attention";
        else if (watching) status = "watching";
        else if (m === undefined) status = on ? "connected" : "not-added";
        else status = "imported";
        rows.push({
          id: opt.id,
          kind: opt.kind,
          status,
          items: agent ? (m?.conversations ?? 0) : (m?.entries ?? 0),
          yourShare: share.get(opt.kind) ?? 0,
          storedIn: STORED_IN[opt.id] ?? "",
          watching,
          ...(m?.importedAt ? { lastImport: m.importedAt } : {}),
        });
      }
      for (const f of s.sources.folders) {
        const id = `folder:${f.id}`;
        const m = manifest.sources[id];
        const choice = s.you.speakerBySource[id];
        rows.push({
          id,
          kind: "files",
          status: m?.status === "error" || m?.status === "changed" ? "attention" : !f.enabled ? "not-added" : f.watch ? "watching" : m ? "imported" : "connected",
          items: m?.entries ?? 0,
          yourShare: choice === "you" ? 1 : 0,
          ...(m?.importedAt ? { lastImport: m.importedAt } : {}),
          storedIn: ".raw/chats/files/",
          watching: f.enabled && f.watch,
        });
      }
      return rows;
    },

    async files() {
      const d = need();
      if (d.sandbox?.()) return [];
      const rows: FileRow[] = [];
      for (const { file } of await states(d)) {
        for (const [key, st] of Object.entries(file.files)) {
          if (rows.length >= MAX_FILE_ROWS) return rows;
          rows.push({ path: st.path || key, name: path.basename(st.path || key), bytes: Math.max(0, st.size), versions: st.versions, state: st.changed ? "changed" : "unchanged", exportable: true });
        }
      }
      return rows.sort((a, b) => a.path.localeCompare(b.path));
    },

    async needsAttention() {
      const d = need();
      const out: AttentionRow[] = [];
      // The sample record has no sources of its own to be worried about (and the real ones are not its business).
      if (d.sandbox?.()) return out;
      const h = d.health?.();
      if (h?.indexFailure) out.push({ code: "index-failed", count: 1, ...(h.indexFailure === "none" ? { detail: "none" } : {}), action: "rebuild-index" });
      if (h?.runner === "unavailable") out.push({ code: "runner-unavailable", count: 1, action: "export-diagnostics" });
      const missing = await notLocal(d);
      if (missing.length > 0) out.push({ code: "not-local", count: missing.length, action: "fetch-now" });
      let changed = 0;
      for (const { file } of await states(d)) for (const st of Object.values(file.files)) if (st.changed) changed++;
      if (changed > 0) out.push({ code: "changed-at-source", count: changed, action: "show" });
      const cc = d.settings.value.sources.claudeCode;
      const projects = claudeProjectsDir(cc.projectsDir);
      if (cc.enabled && !pathExists(projects)) out.push({ code: "path-unreadable", count: 1, detail: projects, action: "show-details" });
      const manifest = await loadSourceManifest(d);
      for (const m of Object.values(manifest.sources)) {
        if (m.status === "error" && typeof m.error === "string" && !out.some((r) => r.code === m.error)) out.push({ code: m.error as WarningCode, count: 1, action: "show-details" });
      }
      return out;
    },

    async estimate() {
      const d = need();
      // The sample record never looks at the person's real folders, notes or sessions (no runner request at all).
      if (d.sandbox?.()) return { sources: [], conversations: 0, notes: 0, tokens: 0 };
      const s = d.settings.value;
      const sels = selectorsOf(s);
      const base: EstimateResult = sels.length > 0 ? await d.runner.request({ cmd: "import.estimate", args: { sources: sels } }) : { sources: [], conversations: 0, notes: 0, tokens: 0 };
      // Obsidian's own index knows every note, wiki notes included: it replaces the runner's count of the notes outside wiki/.
      if (!s.sources.vault.enabled) return base;
      const mine = vaultCounts(d);
      const theirs = base.sources.find((x) => x.source === "obsidian");
      const before = theirs ? theirs.items - theirs.reference : 0;
      const after = mine.notes - mine.reference;
      const sources = base.sources.filter((x) => x.source !== "obsidian");
      sources.push({ source: "obsidian", items: mine.notes, reference: mine.reference });
      const tokens = Math.max(0, base.tokens + (after - before) * TOKENS_PER_NOTE);
      return { sources, conversations: base.conversations, notes: Math.max(0, base.notes + after - before), tokens };
    },

    async inspect(file) {
      const d = need();
      return d.runner.request({ cmd: "import.inspect", args: { file } });
    },

    async importNow(source, onProgress) {
      const d = need();
      notSample(d);
      if (source.kind === "raw") {
        // "Import again": changed documents get a new version (importers/rawDocs.ts reads this request).
        await writeJsonAtomic(cacheWritablePath(d.cacheDir, "state/import-changed.json"), { v: 1, all: true });
      }
      return d.runner.request(
        { cmd: "import", args: { sources: [source] } },
        onProgress
          ? {
              onProgress: (f) => {
                const kept = f.note !== undefined && /^\d+$/.test(f.note) ? Number(f.note) : undefined;
                onProgress({ done: f.done, ...(f.total !== undefined ? { total: f.total } : {}), ...(kept !== undefined ? { kept } : {}) });
              },
            }
          : undefined,
      );
    },

    async pauseWatching(id, paused) {
      const d = need();
      await d.settings.update((s) => {
        if (id === "claude-code") s.sources.claudeCode.watch = !paused;
        else if (agentKeyOf(id)) s.sources[agentKeyOf(id) as "cursor"].watch = !paused;
        else if (id === "capture") s.sources.capture.paused = paused;
        else if (id === "vault") s.sources.vault.enabled = !paused;
        else if (id === "raw") s.sources.raw.enabled = !paused;
        else if (id === "written") s.sources.written.enabled = !paused;
        else if (id.startsWith("folder:")) {
          const f = s.sources.folders.find((x) => `folder:${x.id}` === id);
          if (f) f.watch = !paused;
        }
      });
    },

    async remove(id) {
      const d = need();
      notSample(d);
      // Stop first, so nothing new arrives while the exclusion is written.
      await d.settings.update((s) => {
        if (id === "claude-code") {
          s.sources.claudeCode.enabled = false;
          s.sources.claudeCode.watch = false;
        } else if (id === "vault") s.sources.vault.enabled = false;
        else if (id === "raw") s.sources.raw.enabled = false;
        else if (id === "written") s.sources.written.enabled = false;
        else if (id === "claude-ai") s.sources.claudeAi.enabled = false;
        else if (id === "chatgpt") s.sources.chatgpt.enabled = false;
        else if (id === "gemini") s.sources.gemini.enabled = false;
        else if (id === "notion") s.sources.notion.enabled = false;
        else if (id === "google-docs") s.sources.googleDocs.enabled = false;
        else if (isChatExportKey(id)) s.sources.chatExports[id].enabled = false;
        else if (agentKeyOf(id)) {
          const a = s.sources[agentKeyOf(id) as "cursor"];
          a.enabled = false;
          a.watch = false;
        } else if (id === "capture") {
          s.sources.capture.enabled = false;
          for (const site of Object.keys(s.sources.capture.sites) as (keyof typeof s.sources.capture.sites)[]) s.sources.capture.sites[site] = false;
        } else if (id.startsWith("folder:")) {
          const f = s.sources.folders.find((x) => `folder:${x.id}` === id);
          if (f) {
            f.enabled = false;
            f.watch = false;
          }
        }
      });
      await d.corrections.exclude(id, "source", "sources");
    },

    reveal(id) {
      if (!deps) return;
      const s = deps.settings.value;
      const rel = id === "vault" ? "" : id === "raw" ? ".raw" : id === "written" ? ".raw/written" : id === "claude-code" || id === "claude-ai" || id === "chatgpt" || id === "gemini" || id === "notion" || id === "google-docs" || isChatExportKey(id) || agentKeyOf(id) || id === "capture" ? `.raw/chats/${id}` : undefined;
      if (id === "claude-code" && s.sources.claudeCode.projectsDir.trim() !== "") {
        void electron()?.shell?.openPath?.(s.sources.claudeCode.projectsDir);
        return;
      }
      const folder = id.startsWith("folder:") ? s.sources.folders.find((f) => `folder:${f.id}` === id) : undefined;
      if (folder) {
        void electron()?.shell?.openPath?.(folder.path);
        return;
      }
      if (rel === undefined) return;
      const abs = resolveInVault(deps.vaultRoot, rel === "" ? "." : rel);
      void electron()?.shell?.openPath?.(abs);
    },

    async fetchNow() {
      const d = need();
      const file = path.join(cacheLayout(d.cacheDir).state, "not-local.json");
      const cur = await readJsonIfExists<NotLocalFile>(file).catch(() => null);
      if (!cur || cur.v !== 1) return;
      const next: NotLocalFile = { v: 1, bySource: {} };
      // Reading a placeholder makes OneDrive download it; what still fails stays on the list.
      for (const [key, paths] of Object.entries(cur.bySource ?? {})) {
        const still: string[] = [];
        for (const p of paths) {
          const abs = path.isAbsolute(p) ? p : resolveInVault(d.vaultRoot, p);
          const ok = await Promise.race([
            fsp.open(abs, "r").then(async (fh) => {
              try {
                await fh.read(Buffer.alloc(1), 0, 1, 0);
                return true;
              } finally {
                await fh.close();
              }
            }),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FETCH_TIMEOUT_MS)),
          ]).catch((e: unknown) => errCode(e) === "ENOENT");
          if (!ok) still.push(p);
        }
        if (still.length > 0) next.bySource[key] = still;
      }
      await writeJsonAtomic(cacheWritablePath(d.cacheDir, "state/not-local.json"), next);
      const fetched = Object.keys(cur.bySource ?? {}).filter((k) => !(k in next.bySource));
      if (fetched.length > 0 && !d.sandbox?.()) {
        const sels = selectorsOf(d.settings.value);
        if (sels.length > 0) await d.runner.request({ cmd: "import", args: { sources: sels } }).catch((e: unknown) => d.log.warn("import after Fetch now failed", { code: e instanceof CortexError ? e.code : "E_INTERNAL" }));
      }
    },

    async exportFile(p) {
      const d = need();
      if (!d.save) throw new CortexError("E_INTERNAL", "saving files is not connected");
      const known = (await states(d)).some(({ file }) => Object.values(file.files).some((st) => st.path === p) || p in file.files);
      if (!known) throw new CortexError("E_BAD_REQUEST", "this file is not one Cortex imported");
      const abs = path.isAbsolute(p) ? p : resolveInVault(d.vaultRoot, p);
      const bytes = await fsp.readFile(abs);
      await d.save({ suggestedName: path.basename(abs), mime: "application/octet-stream", data: new Uint8Array(bytes) });
    },
  };
}

// ───────────────────────────── folder helpers for the Add sources dialog ─────────────────────────────

const LIST_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".obsidian", ".claude", ".ssh", "Excalidraw"]);

/**
 * Relative paths of the files "Ask per file" asks about: the chosen extensions only, at most `limit`. The
 * importer applies the never-read list and the Off limits rows again, so a file listed here can still be skipped.
 */
async function listFolderFiles(root: string, extensions: readonly string[], limit = 300): Promise<string[]> {
  const want = new Set(extensions.map((e) => e.toLowerCase()));
  const out: string[] = [];
  const stack: { abs: string; rel: string }[] = [{ abs: root, rel: "" }];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop() as { abs: string; rel: string };
    let entries;
    try {
      entries = await fsp.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = dir.rel === "" ? e.name : `${dir.rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!LIST_SKIP_DIRS.has(e.name)) stack.push({ abs: path.join(dir.abs, e.name), rel });
      } else if (e.isFile() && want.has(path.extname(e.name).slice(1).toLowerCase()) && out.length < limit) out.push(rel);
    }
  }
  return out;
}

/** Keep the "Ask per file" answers where importers/folders.ts reads them. */
async function saveFolderSpeakers(cacheDir: string, folderId: string, files: Record<string, "you" | "other">): Promise<void> {
  const name = `state/folder-speakers-${folderId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
  await writeJsonAtomic(cacheWritablePath(cacheDir, name), { v: 1, files });
}
