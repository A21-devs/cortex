/**
 * Runner command handlers. Owner: E5. The handlers only wire the owners' modules together: importers (E3/E4)
 * through the registry, the index and search builders (E7), the ledger (E2), and the agent scheduler (E5).
 *
 * Every handler opens its own StoreContext for the request (cheap: it creates folders that exist already), checks
 * the kill switches through the modules it calls, and reports counts, ids and enum codes only (SAFE-17).
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { ClaudeCliEngine } from "../agents/claudeCli";
import { CodexCliEngine } from "../agents/codexCli";
import { RuleEngine } from "../agents/ruleLabels";
import type { Engine } from "../agents/engine";
import { LocalEngine } from "../agents/localEngine";
import { discardChecks } from "../agents/discard";
import type { JobContext } from "../agents/jobs";
import { scanScreened } from "../agents/screenScan";
import { noGrantReason, summariseReads } from "../agents/grants";
import { localDayKey } from "../shared/time";
import { AgentScheduler, dequeueJobs, enqueueJobs, runLiveCheck } from "../agents/scheduler";
import { createImporters, estimateSources } from "../importers/registry";
import { emptyStats, knownIdsFromLedger, newTally, type ImportContext } from "../importers/common";
import { inspectExport } from "../importers/inspect";
import { agentCwd, claudeProjectsDir, codexCwd, findClaudeCandidates, findCodexCandidates, findNode } from "../node/platform";
import { locksDirOf, withLock } from "../node/locks";
import { asCortexError, CortexError } from "../shared/errors";
import type { DoctorCheck, DoctorResult, ImportArgs, ImportResult, RunnerEvent, SourceImportStats } from "../shared/protocol/runner";
import type { SourceKind } from "../shared/types";
import { openControlGate } from "../store/control";
import { autoTimestamp, checkPublicStamps, exportProof, runDateEvidence, publishSeals, sealStatus } from "../store/dateEvidence";
import { buildRecordIndex } from "../store/indexBuilder";
import { cacheLayout, openStoreContext, type StoreContext } from "../store/layout";
import { compactLedgers, createLedgerStore, type LedgerStore } from "../store/ledger";
import { buildSearchIndex } from "../store/searchIndex";
import { RUNNER_BUILD, RUNNER_VERSION, type CommandHandlers, type RequestContext } from "./host";
import { packHandlers } from "./packCommands";

/** Lock stale limit: 60 s for child and worker runners, at least 5 min on the UI thread (inline). */
const LOCK_STALE_CHILD_MS = 60_000;
const LOCK_STALE_INLINE_MS = 5 * 60_000;

interface Opened {
  store: StoreContext;
  ledger: LedgerStore;
}

export async function openRequestStore(rc: RequestContext): Promise<Opened> {
  const store = await openStoreContext({
    vaultRoot: rc.ctx.vaultRoot,
    cacheDir: rc.ctx.cacheDir,
    owner: `runner:${process.pid}`,
    log: rc.host.log,
    lockStaleMs: rc.host.mode === "inline" ? LOCK_STALE_INLINE_MS : LOCK_STALE_CHILD_MS,
  });
  return { store, ledger: createLedgerStore(store) };
}

/** The engine for this request's settings: the Claude Code CLI, run headless with no tools (SAFE-05). */
export function engineFor(rc: RequestContext, store: StoreContext): ClaudeCliEngine {
  const { settings } = rc.ctx;
  const exe = findClaudeCandidates(settings.agents.claudePath)[0] ?? "";
  return new ClaudeCliEngine(
    { exe, cwd: agentCwd(), tmpDir: path.join(store.cacheDir, "tmp"), useJsonSchemaFlag: settings.agents.useJsonSchemaFlag, projectsDir: claudeProjectsDir(settings.sources.claudeCode.projectsDir) },
    rc.host.log,
  );
}

/** The engine a scheduler pass uses: a model on this computer when the setting says so, else the Claude Code CLI. */
function passEngine(rc: RequestContext, store: StoreContext): { engine: Engine; liveCheck: ((o: { model: string; timeoutMs: number; signal: AbortSignal }) => ReturnType<ClaudeCliEngine["liveCheck"]>) | null } {
  if (rc.ctx.settings.agents.engine === "local") return { engine: new LocalEngine(rc.ctx.settings.agents.local), liveCheck: null };
  // No model: the rule organiser (agents/ruleLabels.ts). Nothing is sent anywhere.
  if (rc.ctx.settings.agents.engine === "none") return { engine: new RuleEngine(), liveCheck: null };
  if (rc.ctx.settings.agents.engine === "codex-cli") {
    const codex = rc.ctx.settings.agents.codex;
    const exe = findCodexCandidates(codex.path)[0] ?? "";
    return { engine: new CodexCliEngine({ exe, cwd: codexCwd(), tmpDir: path.join(store.cacheDir, "tmp"), model: codex.model }, rc.host.log), liveCheck: null };
  }
  const cli = engineFor(rc, store);
  return { engine: cli, liveCheck: (o) => cli.liveCheck(o) };
}

function schedulerFor(rc: RequestContext, opened: Opened): { scheduler: AgentScheduler; engine: Engine } {
  const { engine, liveCheck } = passEngine(rc, opened.store);
  const scheduler = new AgentScheduler({
    store: opened.store,
    ledger: opened.ledger,
    settings: rc.ctx.settings,
    engine,
    liveCheck,
    token: rc.token,
    log: rc.host.log,
    emit: rc.event,
    now: () => Date.now(),
    mode: rc.host.mode,
    origin: rc.host.mode === "cli" ? "skill" : "plugin",
    settingsSource: rc.ctx.settingsSource,
    pluginVersion: rc.ctx.pluginVersion,
  });
  return { scheduler, engine };
}

/** An importer context for this request (imports, inspect and estimate share it). */
function importContext(rc: RequestContext, opened: Opened, opts: { maxSeconds?: number; maxEntries?: number; dryRun?: boolean; options?: Record<string, unknown> } = {}): Promise<ImportContext> {
  return openControlGate(opened.store).then((gate) => {
    const now = Date.now();
    const ctx: ImportContext = {
      store: opened.store,
      ledger: opened.ledger,
      settings: rc.ctx.settings,
      mayContinue: async () => (await gate.check()).ok,
      token: rc.token,
      log: rc.host.log,
      progress: (p) => rc.progress(p.phase, p.done, p.total, p.unit, p.note),
      yield: () => rc.host.yield(),
      now: () => Date.now(),
      knownEntryIds: async () => new Set(),
      tally: newTally(),
    };
    if (opts.maxSeconds !== undefined && opts.maxSeconds > 0) ctx.deadline = now + opts.maxSeconds * 1000;
    if (opts.maxEntries !== undefined && opts.maxEntries > 0) ctx.maxEntries = opts.maxEntries;
    if (opts.dryRun) ctx.dryRun = true;
    if (opts.options) ctx.options = opts.options;
    return ctx;
  });
}

function withKnownIds(ctx: ImportContext): ImportContext {
  ctx.knownEntryIds = (conv) => knownIdsFromLedger(ctx, conv);
  return ctx;
}

/** Cache files that can be rebuilt from the vault (everything else in the cache folder is state and stays). */
const CACHE_FILES: readonly string[] = ["record.cxi", "record.delta.cxi", "vault.cxi", "vault.cxi.key", "offsets.bin", "signal.json"];
const CACHE_DIRS: readonly { dir: "searchDir" | "agg" | "tmp"; match: RegExp }[] = [
  { dir: "searchDir", match: /^[\w.-]+\.(?:cxs|json|bin|sig)$/ },
  { dir: "agg", match: /^[\w.-]+\.json$/ },
  { dir: "tmp", match: /^[\w.-]+\.(?:txt|json|tmp)$/ },
];

async function clearCache(cacheDir: string): Promise<{ files: number; bytes: number }> {
  if (!(await exists(path.join(cacheDir, ".cortex-cache")))) throw new CortexError("E_PATH_DENIED", "the cache folder has no marker", { detail: { reason: "no-marker" } });
  const layout = cacheLayout(cacheDir);
  let files = 0;
  let bytes = 0;
  const drop = async (abs: string): Promise<void> => {
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return;
      await fsp.unlink(abs);
      files++;
      bytes += st.size;
    } catch {
      // gone already, or in use: a cache that stays is rebuilt over
    }
  };
  for (const name of CACHE_FILES) await drop(path.join(cacheDir, name));
  for (const { dir, match } of CACHE_DIRS) {
    const base = layout[dir];
    const names = await fsp.readdir(base).catch(() => [] as string[]);
    for (const n of names) if (match.test(n)) await drop(path.join(base, n));
  }
  for (const n of await fsp.readdir(cacheDir).catch(() => [] as string[])) if (/^slots-[\w-]+\.bin$/.test(n)) await drop(path.join(cacheDir, n));
  return { files, bytes };
}

function warnEvents(ctx: ImportContext, rc: RequestContext): void {
  for (const [code, n] of ctx.tally?.warnings ?? []) {
    if (code === "import-failed") continue;
    rc.event({ kind: "warning", code, detail: { count: n } });
  }
}

export function createHandlers(): CommandHandlers {
  return {
    doctor: async (args, rc): Promise<DoctorResult> => {
      const { settings, vaultRoot, cacheDir } = rc.ctx;
      const checks: DoctorCheck[] = [];
      const major = Number(/^v(\d+)/.exec(process.version)?.[1] ?? 0);
      checks.push({ id: "node", ok: major >= 20, detail: `node ${process.version} (${rc.host.mode})` });
      const sysNode = await findNode(settings.advanced.nodePath);
      checks.push({ id: "system-node", ok: sysNode !== undefined, detail: sysNode ? `${sysNode.path} ${sysNode.version}` : "not found (the plugin will run imports inside Obsidian, slower)" });
      checks.push({ id: "vault", ok: await exists(path.join(vaultRoot, ".obsidian")), detail: vaultRoot });
      const projects = claudeProjectsDir(settings.sources.claudeCode.projectsDir);
      const projectCount = (await fsp.readdir(projects).catch(() => [] as string[])).length;
      checks.push({ id: "claude-transcripts", ok: projectCount > 0, detail: `${projects} (${projectCount} project folders)` });
      checks.push({ id: "cache-dir", ok: true, detail: cacheDir });
      checks.push({ id: "settings", ok: rc.ctx.settingsSource !== "defaults", detail: `settings from ${rc.ctx.settingsSource}` });
      const claudePath = findClaudeCandidates(settings.agents.claudePath)[0];
      let claude: DoctorResult["claude"] = { path: claudePath ?? "", flags: {}, missingMandatory: [], envKeys: [], liveCheck: "skipped" };
      if (claudePath) {
        await fsp.mkdir(agentCwd(), { recursive: true });
        const opened = await openRequestStore(rc);
        const engine = engineFor(rc, opened.store);
        const probe = await engine.probe();
        claude = { path: claudePath, ...(probe.version !== undefined ? { version: probe.version } : {}), flags: probe.flags, missingMandatory: probe.missingMandatory, envKeys: engine.envKeys(), liveCheck: "skipped" };
        checks.push({ id: "claude-cli", ok: probe.ok, detail: `${claudePath} ${probe.version ?? ""} ${probe.detail}`.trim() });
        const folder = await fsp.readdir(agentCwd()).catch(() => [] as string[]);
        checks.push({ id: "agent-folder", ok: folder.length === 0, detail: folder.length === 0 ? agentCwd() : `${agentCwd()} holds ${folder.length} item(s); Claude Code would load them` });
        if (args.live) {
          // User-approved (the caller asked for --live): one tiny fixed prompt, stream-json, tools and MCP must be
          // absent from the init event, no tool use, one turn, no new session folder (SAFE-05). It spends a few
          // tokens, reserved and settled against today's cap like any call.
          if (!probe.ok || probe.version === undefined) claude.liveCheck = "failed";
          else {
            try {
              await runLiveCheck(
                { store: opened.store, emit: rc.event, now: () => Date.now(), settings, engine, liveCheck: (o) => engine.liveCheck(o), token: rc.token, log: rc.host.log },
                probe.version,
              );
              claude.liveCheck = "ok";
            } catch (e) {
              const err = asCortexError(e);
              if (err.code === "E_CANCELLED") throw err;
              claude.liveCheck = "failed";
              checks.push({ id: "live-check", ok: false, detail: err.code });
            }
          }
          if (claude.liveCheck === "ok") checks.push({ id: "live-check", ok: true, detail: "no tools, no MCP servers, one turn" });
        }
      } else {
        checks.push({ id: "claude-cli", ok: false, detail: "claude.exe not found (set Settings › Agents › Claude Code path)" });
      }
      if (settings.agents.engine === "codex-cli") {
        // The free check only: the version and the help of the person's own Codex CLI (no prompt is ever sent).
        const codexPath = findCodexCandidates(settings.agents.codex.path)[0];
        if (codexPath) {
          const probe = await new CodexCliEngine({ exe: codexPath, cwd: codexCwd(), tmpDir: path.join(cacheDir, "tmp"), model: settings.agents.codex.model }, rc.host.log).probe();
          checks.push({ id: "codex-cli", ok: probe.ok, detail: `${codexPath} ${probe.version ?? ""} ${probe.detail}`.trim() });
        } else {
          checks.push({ id: "codex-cli", ok: false, detail: "codex.exe not found (set Settings › Agents › Codex path; the .cmd shim cannot be launched)" });
        }
      }
      return { node: process.version, runner: RUNNER_VERSION, build: RUNNER_BUILD, claude, checks };
    },

    import: async (args: ImportArgs, rc): Promise<ImportResult> => {
      const t0 = Date.now();
      const opened = await openRequestStore(rc);
      const options: Record<string, unknown> = {};
      if (args.seal === true) options.seal = true;
      const changed = (args as { importChanged?: unknown }).importChanged;
      if (changed !== undefined) options.importChanged = changed;
      const ctx = withKnownIds(await importContext(rc, opened, { ...(args.maxSeconds !== undefined ? { maxSeconds: args.maxSeconds } : {}), ...(args.maxEntries !== undefined ? { maxEntries: args.maxEntries } : {}), ...(args.dryRun ? { dryRun: true } : {}), options }));
      const importers = createImporters();
      const tally = ctx.tally ?? newTally();
      ctx.tally = tally;
      return withLock(locksDirOf(opened.store.cacheDir), "runner:import", { owner: opened.store.owner, staleMs: opened.store.lockStaleMs, waitMs: 0 }, async () => {
        const sources: SourceImportStats[] = [];
        let n = 0;
        for (const sel of args.sources) {
          rc.token.throwIfCancelled();
          const importer = importers[sel.kind];
          if (!importer) throw new CortexError("E_BAD_REQUEST", "unknown source", { detail: { reason: "source-kind" } });
          rc.progress("import", n++, args.sources.length, "sources", sel.kind);
          try {
            sources.push(await importer.run(sel, ctx));
          } catch (e) {
            const err = asCortexError(e);
            if (err.code === "E_CANCELLED" || err.code === "E_LOCKED") throw err;
            rc.host.log.warn("a source failed", { source: sel.kind, code: err.code });
            const s = emptyStats(importer.source, importer.label);
            s.errors.push({ file: sel.kind, message: err.code });
            sources.push(s);
          }
          if (tally.partial) break;
        }
        warnEvents(ctx, rc);
        const entriesAdded = sources.reduce((a, s) => a + s.entriesAdded, 0);
        const conversationsTouched = tally.conversations.size > 0 ? tally.conversations.size : sources.reduce((a, s) => a + s.conversationsTouched, 0);
        const seq = await opened.ledger.seq();
        if (!args.dryRun && (entriesAdded > 0 || tally.staged > 0)) {
          const kinds = [...new Set(sources.filter((s) => s.entriesAdded > 0).map((s) => s.source))] as SourceKind[];
          const e: RunnerEvent = { kind: "entries-added", count: entriesAdded + tally.staged, conversations: conversationsTouched, sources: kinds, seq, live: tally.staged > 0 };
          rc.event(e);
        }
        // Date evidence follows what was just added (seals when they are on, git first-seen dates); it never fails the import.
        // The git pass reads the whole ledger and every file it names: it only follows imports that added files living
        // in the vault (notes, .raw documents, folders are elsewhere, written entries), not chat transcripts or exports.
        if (!args.dryRun && entriesAdded > 0) {
          const inVault = sources.some((s) => s.entriesAdded > 0 && (s.source === "obsidian" || s.source === "files" || s.source === "written"));
          const seal = rc.ctx.settings.advanced.dateSeals.sealLocally;
          if (seal || inVault) await runDateEvidence(opened.store, opened.ledger, { seal, skipGit: !inVault, signAs: rc.ctx.settings.advanced.dateSeals.signAs });
        }
        return { entriesAdded, conversationsTouched, staged: tally.staged, secretsHeld: tally.secretsHeld, sources, seq, partial: tally.partial, durationMs: Date.now() - t0 };
      });
    },

    "index.build": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return withLock(locksDirOf(opened.store.cacheDir), "runner:index", { owner: opened.store.owner, staleMs: opened.store.lockStaleMs, waitMs: 0 }, async () => {
        const res = await buildRecordIndex({ store: opened.store, ledger: opened.ledger, token: rc.token, progress: (done, total) => rc.progress("index", done, total, "entries"), yield: () => rc.host.yield() }, { full: args.full === true });
        rc.event({ kind: "index-built", file: res.file, seq: res.seq, count: res.count });
        return res;
      });
    },

    "search.build": async (args, rc) => {
      void args;
      const t0 = Date.now();
      const opened = await openRequestStore(rc);
      return withLock(locksDirOf(opened.store.cacheDir), "runner:search", { owner: opened.store.owner, staleMs: opened.store.lockStaleMs, waitMs: 0 }, async () => {
        const res = await buildSearchIndex({ store: opened.store, ledger: opened.ledger, token: rc.token, progress: (done, total) => rc.progress("search", done, total, "documents"), yield: () => rc.host.yield() });
        rc.event({ kind: "search-built", file: res.file, seq: await opened.ledger.seq() });
        return { file: res.file, terms: res.terms, docs: res.docs, durationMs: Date.now() - t0 };
      });
    },

    "agents.run": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return schedulerFor(rc, opened).scheduler.run(args);
    },

    "agents.status": async (_args, rc) => {
      const opened = await openRequestStore(rc);
      return schedulerFor(rc, opened).scheduler.status();
    },

    "agents.enqueue": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return { queued: await enqueueJobs(opened.store, args) };
    },

    "agents.dequeue": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return { removed: await dequeueJobs(opened.store, args.ids) };
    },

    "review.discard": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return { discarded: await discardChecks(opened.ledger, args) };
    },

    "ai.ask": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return schedulerFor(rc, opened).scheduler.ask(args);
    },

    "import.inspect": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return inspectExport(args, withKnownIds(await importContext(rc, opened)));
    },

    "import.estimate": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return estimateSources(args.sources, await importContext(rc, opened));
    },

    "cache.clear": async (_args, rc) => {
      const opened = await openRequestStore(rc);
      return withLock(locksDirOf(opened.store.cacheDir), "runner:import", { owner: opened.store.owner, staleMs: opened.store.lockStaleMs, waitMs: 0 }, () => clearCache(opened.store.cacheDir));
    },

    "ledger.compact": async (args, rc) => {
      const opened = await openRequestStore(rc);
      return compactLedgers(opened.store, { ...(args.month !== undefined ? { month: args.month } : {}), accessLogRetention: rc.ctx.settings.privacy.accessLogRetention, token: rc.token });
    },

    "seals.run": async (args, rc) => {
      const opened = await openRequestStore(rc);
      const r = await runDateEvidence(opened.store, opened.ledger, { seal: rc.ctx.settings.advanced.dateSeals.sealLocally, force: args.force === true, signAs: rc.ctx.settings.advanced.dateSeals.signAs });
      const status = await sealStatus(opened.store.vaultRoot);
      return { blocks: r.sealed?.blocks ?? 0, entries: r.sealed?.entries ?? 0, total: status.blocks, gitChecked: r.git?.checked ?? 0, gitFound: r.git?.found ?? 0 };
    },

    "seals.status": async (_args, rc) => {
      const s = await sealStatus(rc.ctx.vaultRoot);
      return {
        blocks: s.blocks,
        entries: s.entries,
        intact: s.intact,
        ...(s.lastAt !== undefined ? { lastAt: s.lastAt } : {}),
        ...(s.published ? { published: s.published } : {}),
        ...(s.key !== undefined ? { key: s.key } : {}),
        pending: s.pending,
        ...(s.confirmed ? { confirmed: s.confirmed } : {}),
        outward: s.outward,
      };
    },

    "seals.publish": async (_args, rc) => {
      const opened = await openRequestStore(rc);
      return publishSeals(opened.store);
    },

    "seals.check": async (_args, rc) => {
      const opened = await openRequestStore(rc);
      return checkPublicStamps(opened.store);
    },

    // The standing weekly consent is read from the settings of THIS request, so turning it off takes effect at once.
    "seals.auto": async (_args, rc) => {
      const d = rc.ctx.settings.advanced.dateSeals;
      if (!d.sealLocally || !d.weeklyStamp) return { enabled: false, stamped: false, checked: false };
      const opened = await openRequestStore(rc);
      const r = await autoTimestamp(opened.store);
      return { enabled: true, stamped: r.stamped, checked: r.checked };
    },

    // Read-only: counts what the privacy screen would replace; the local-model pass only proposes names.
    "privacy.screened": async (args, rc) => {
      const opened = await openRequestStore(rc);
      const settings = rc.ctx.settings;
      const jc: JobContext = { engine: new RuleEngine(), ledger: opened.ledger, store: opened.store, settings, privacyRev: 0, token: rc.token, log: rc.host.log, emit: rc.event };
      // Consent: the local-model pass reads text too, so with "Require a grant" on it waits for a grant that names a local model.
      const mayPropose = noGrantReason(settings.consent, "local", localDayKey(Date.now())) === null;
      return scanScreened(jc, { proposeNames: args.proposeNames === true && mayPropose, engine: settings.agents.engine === "local" ? new LocalEngine(settings.agents.local) : null });
    },

    // Read-only: how often each item and grant was read, from the read log (counts and titles only).
    "consent.reads": async (_args, rc) => {
      const opened = await openRequestStore(rc);
      return summariseReads(opened.ledger.readAll("reads"), rc.ctx.settings.consent, async (ids) => {
        const out = new Map<string, string>();
        if (ids.size === 0) return out;
        const convs = new Map<string, string>();
        for await (const c of opened.ledger.readAll("conversations")) if (typeof c.title === "string") convs.set(c.id, c.title);
        for await (const e of opened.ledger.readAll("entries")) {
          if (!ids.has(e.id)) continue;
          out.set(e.id, (e.title ?? (e.conv ? convs.get(e.conv) : undefined) ?? "").replace(/\s+/g, " ").trim().slice(0, 80));
          if (out.size >= ids.size) break;
        }
        return out;
      });
    },

    "seals.proof": async (args, rc) => {
      const opened = await openRequestStore(rc);
      const b = await exportProof(opened.store, args.n !== undefined ? { n: args.n } : {});
      return { n: b.block.n, json: `${JSON.stringify(b, null, 2)}
` };
    },

    // Prove this entry, Audit pack, Export my record (runner/packCommands.ts)
    ...packHandlers(openRequestStore),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

