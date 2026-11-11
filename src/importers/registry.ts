/**
 * Importer registry: maps SourceSelector kinds to importers. Owner: E3.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { EstimateResult, SourceEstimate, SourceSelector } from "../shared/protocol/runner";
import { claudeProjectsDir } from "../node/platform";
import { ChatgptImporter } from "./chatgpt";
import { ClaudeAiImporter } from "./claudeAi";
import { ClaudeCodeImporter, type ClaudeCodeFile } from "./claudeCode";
import { trackNotLocal, type DiscoveredUnit, type ImportContext, type Importer } from "./common";
import { extraImporters } from "./extra";
import { FolderImporter } from "./folders";
import { GeminiImporter } from "./gemini";
import { RawDocsImporter } from "./rawDocs";
import { VaultNotesImporter } from "./vaultNotes";
import { WrittenImporter } from "./written";

export type AnyImporter = Importer<SourceSelector>;

type CoreKind = "claude-code" | "claude-ai" | "chatgpt" | "gemini" | "raw" | "folder" | "written" | "vault-notes";

export function createImporters(): Record<SourceSelector["kind"], AnyImporter> {
  const core: Record<CoreKind, AnyImporter> = {
    "claude-code": new ClaudeCodeImporter() as unknown as AnyImporter,
    "claude-ai": new ClaudeAiImporter() as unknown as AnyImporter,
    chatgpt: new ChatgptImporter() as unknown as AnyImporter,
    gemini: new GeminiImporter() as unknown as AnyImporter,
    raw: new RawDocsImporter() as unknown as AnyImporter,
    folder: new FolderImporter() as unknown as AnyImporter,
    written: new WrittenImporter() as unknown as AnyImporter,
    "vault-notes": new VaultNotesImporter() as unknown as AnyImporter,
  };
  // Importer packages register through importers/extra/index.ts, never here.
  const extra = extraImporters();
  for (const kind of Object.keys(extra)) if (Object.hasOwn(core, kind)) throw new Error(`importer kind "${kind}" is built in and cannot be registered again`);
  const all = { ...core, ...extra } as Record<SourceSelector["kind"], AnyImporter>;
  // Every pass keeps the list of files found only as OneDrive placeholders (Sources › Fetch now).
  for (const [key, imp] of Object.entries(all)) {
    const run = imp.run.bind(imp);
    imp.run = (sel, ctx) => trackNotLocal(ctx, key, () => run(sel, ctx));
  }
  return all;
}

// ───────────────────────────── estimate (first-run step, SAFE-11) ─────────────────────────────

/** Rough tokens to label and summarise one conversation / one note (CORTEX-UX §5.26 backlog line). */
export const TOKENS_PER_CONVERSATION = 2500;
export const TOKENS_PER_NOTE = 1100;

/** Does the head of a markdown file say `status: reference` in its frontmatter? */
export function headSaysReference(head: string): boolean {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  return m !== null && /^status:[ \t]*["']?reference["']?[ \t]*$/im.test(m[1] ?? "");
}

async function referenceNotes(units: readonly DiscoveredUnit[], ctx: ImportContext): Promise<number> {
  let n = 0;
  for (const u of units) {
    let fh: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      fh = await fsp.open(path.join(ctx.store.vaultRoot, u.path), "r");
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (headSaysReference(buf.subarray(0, bytesRead).toString("utf8"))) n++;
    } catch {
      // unreadable or not on this computer yet: counted as a normal note
    } finally {
      await fh?.close().catch(() => undefined);
    }
    if (n % 200 === 0) await ctx.yield();
  }
  return n;
}

/**
 * Counts for the first-run step and Add sources: directories and file sizes only (plus the first 2 KB of each
 * vault note to count reference notes); nothing is imported, stored or sent. Sources that need an export
 * (Claude.ai, ChatGPT, Gemini) are estimated by `import.inspect`, not here.
 */
export async function estimateSources(selectors: readonly SourceSelector[], ctx: ImportContext): Promise<EstimateResult> {
  const importers = createImporters();
  const sources: SourceEstimate[] = [];
  let conversations = 0;
  let notes = 0;
  for (const sel of selectors) {
    switch (sel.kind) {
      case "claude-code": {
        const files = (await importers["claude-code"].discover(sel, ctx)) as ClaudeCodeFile[];
        const items = files.filter((f) => !f.isSubagent || ctx.settings.sources.claudeCode.includeSubagents).length;
        sources.push({ source: "claude-code", items, reference: 0, where: claudeProjectsDir(ctx.settings.sources.claudeCode.projectsDir) });
        conversations += items;
        break;
      }
      case "raw": {
        const units = await importers.raw.discover(sel, ctx);
        sources.push({ source: "files", items: units.length, reference: units.filter((u) => u.label === "reference").length });
        break;
      }
      case "vault-notes": {
        const units = await importers["vault-notes"].discover(sel, ctx);
        const reference = await referenceNotes(units, ctx);
        sources.push({ source: "obsidian", items: units.length, reference });
        notes += units.length - reference;
        break;
      }
      case "folder": {
        const units = await importers.folder.discover(sel, ctx);
        sources.push({ source: "files", items: units.length, reference: 0 });
        notes += units.length;
        break;
      }
      case "written": {
        const units = await importers.written.discover(sel, ctx);
        sources.push({ source: "written", items: units.length, reference: 0 });
        break;
      }
      default:
        break;
    }
  }
  const tokens = conversations * TOKENS_PER_CONVERSATION + notes * TOKENS_PER_NOTE;
  return { sources, conversations, notes, tokens };
}
