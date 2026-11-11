/**
 * Live capture importer: turns what the browser add-on posted (spooled by plugin/captureServer.ts, see
 * store/captureSpool.ts) into entries of source "capture". It reuses the engine of the other live sources
 * (agentSessions.ts), so a captured conversation goes through exactly the same path as a Claude Code session:
 *  - nothing is read until live capture is turned on (`sources.capture.enabled`, off by default);
 *  - only sites you approved are read (a site you switched off keeps its spool files unread);
 *  - exclusions (corrections, Off limits rows) apply before anything is written, and secrets are screened by the
 *    conversation batch (held on this computer, a marker in the record) like everywhere else;
 *  - complete turns are staged at once (this computer only) and sealed into ONE segment when the conversation has
 *    been idle `liveIdleMinutes`, or at the daily seal; ids are stable, so a turn posted twice is one entry;
 *  - a spool file is read again only when its size or time changed; once read and left alone for 14 days it is deleted
 *    (the record holds the text; the spool is only a waiting room).
 */
import { promises as fsp } from "node:fs";
import type { SourceImportStats } from "../shared/protocol/runner";
import { CAPTURE_SITES, captureSiteLabel } from "../shared/capture";
import type { AgentCliSetting, CaptureSiteId, CortexSettings } from "../shared/settings";
import { loadCursors } from "../store/cursors";
import { captureDirs, listSpool, parseSpool } from "../store/captureSpool";
import { readTextIfExists } from "../node/fsAtomic";
import { agentCliImporter, runAgentCli, type AgentCliTool, type AgentSession } from "./agentSessions";
import type { DiscoveredUnit, ImportContext, Importer } from "./common";
import type { ExtraImporterGroup } from "./extra/index";

/** A file that was read and then left alone this long is deleted from the spool. */
export const SPOOL_KEEP_DAYS = 14;

export function approvedSites(s: CortexSettings): CaptureSiteId[] {
  const on = s.sources.capture.sites;
  return CAPTURE_SITES.filter((x) => on[x.id] === true).map((x) => x.id);
}

/** The spool file → one session (null when the file is not a spool file). */
export async function loadCaptureFile(unit: DiscoveredUnit): Promise<AgentSession[]> {
  const text = await readTextIfExists(unit.path);
  const conv = text === null ? null : parseSpool(text);
  if (conv === null || conv.turns.length === 0) return [];
  const session: AgentSession = {
    nativeId: `${conv.site}:${conv.conversation}`,
    project: captureSiteLabel(conv.site),
    messages: conv.turns.map((t) => ({ nativeId: t.id, speaker: t.role === "user" ? ("you" as const) : ("assistant" as const), text: t.text, ts: t.at })),
  };
  if (conv.title !== undefined) session.title = conv.title;
  return [session];
}

/** The tool for one pass: the spool of this cache folder, the sites approved right now. */
export function captureTool(cacheDir: string, s: CortexSettings): AgentCliTool {
  const spool = captureDirs(cacheDir).spool;
  return {
    kind: "capture",
    source: "capture",
    label: "Live capture",
    setting: (x: CortexSettings): AgentCliSetting => ({ enabled: x.sources.capture.enabled, dir: "", watch: true, includeToolOutput: false, liveIdleMinutes: x.sources.capture.liveIdleMinutes }),
    defaultDir: () => spool,
    discover: async () => (await listSpool(cacheDir, approvedSites(s))).map((f) => ({ key: f.abs, path: f.abs, bytes: f.bytes, mtimeMs: f.mtimeMs })),
    load: (unit) => loadCaptureFile(unit),
  };
}

/** Delete spool files that were read completely and have not changed for SPOOL_KEEP_DAYS. Returns how many went. */
export async function pruneSpool(ctx: ImportContext): Promise<number> {
  if (ctx.dryRun) return 0;
  const cursors = (await loadCursors(ctx.store)).files;
  const limit = ctx.now() - SPOOL_KEEP_DAYS * 86_400_000;
  let n = 0;
  for (const f of await listSpool(ctx.store.cacheDir, CAPTURE_SITES.map((x) => x.id))) {
    const cur = cursors[f.abs];
    if (cur === undefined || cur.size !== f.bytes || cur.mtimeMs !== f.mtimeMs || f.mtimeMs > limit) continue;
    await fsp.rm(f.abs, { force: true }).then(
      () => void n++,
      () => undefined,
    );
  }
  return n;
}

export function CaptureImporter(): Importer {
  const base = (ctx: ImportContext): Importer => agentCliImporter(captureTool(ctx.store.cacheDir, ctx.settings));
  return {
    kind: "capture",
    source: "capture",
    label: "Live capture",
    discover: (sel, ctx) => base(ctx).discover(sel, ctx),
    async run(sel, ctx): Promise<SourceImportStats> {
      void sel;
      const stats = await runAgentCli(captureTool(ctx.store.cacheDir, ctx.settings), ctx);
      if (ctx.settings.sources.capture.enabled) await pruneSpool(ctx).catch(() => 0);
      return stats;
    },
  } as Importer;
}

export const captureGroup: ExtraImporterGroup = {
  name: "capture",
  importers: { capture: CaptureImporter() },
};
