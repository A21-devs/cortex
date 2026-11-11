/**
 * Importer group: notes and documents apps. Notion (markdown and csv export, zip or folder) and Google Docs
 * (Takeout Drive docx and html, or a folder of documents). Both are read only from an export the person hands
 * over in Add to your record; nothing is fetched. Each recognises its export for `import.inspect` by member names
 * alone, then counts pages (no text leaves the file) for the preview.
 */
import type { InspectResult } from "../../shared/protocol/runner";
import { googleDocPages, GoogleDocsImporter, looksLikeGoogleDocs } from "../docx";
import { notionPages, NotionImporter, looksLikeNotion } from "../notion";
import { checkExportPath, openProblem } from "../zip";
import { openDocExport } from "../exportDocs";
import type { ImportContext } from "../common";
import type { ExtraImporter, ExtraImporterGroup, ExtraInspector } from "./index";

/** The kinds the sheet knows by id; typed as the protocol's InspectResult kind, which lists only the chat services. */
const asKind = (k: string): InspectResult["kind"] => k as InspectResult["kind"];

function empty(kind: string, problem?: InspectResult["problem"]): InspectResult {
  const out: InspectResult = { kind: asKind(kind), conversations: 0, projects: 0, attachments: 0, alreadyImported: 0 };
  if (problem !== undefined) out.problem = problem;
  return out;
}

const notionInspector: ExtraInspector = {
  kind: "notion",
  recognise: (n) => looksLikeNotion(n),
  async inspect(file, ctx) {
    return inspectPages("notion", file, ctx, (members) => {
      const pages = notionPages(members);
      return { pages: pages.length, projects: new Set(pages.map((p) => p.ancestors[0] ?? p.name.title)).size };
    });
  },
};

const googleDocsInspector: ExtraInspector = {
  kind: "google-docs",
  recognise: (n) => looksLikeGoogleDocs(n),
  async inspect(file, ctx) {
    return inspectPages("google-docs", file, ctx, (members, path) => {
      const pages = googleDocPages(members, path);
      return { pages: pages.length, projects: new Set(pages.map((p) => p.ancestors[0]).filter((x): x is string => x !== undefined)).size };
    });
  },
};

async function inspectPages(kind: string, file: string, ctx: ImportContext, count: (members: { name: string; size: number }[], exportPath: string) => { pages: number; projects: number }): Promise<InspectResult> {
  const blocked = checkExportPath(file, ctx.settings);
  if (blocked) return empty(kind, blocked);
  try {
    const src = await openDocExport(file);
    try {
      const c = count([...src.members], file);
      if (c.pages === 0) return empty(kind, "export-empty");
      const out = empty(kind);
      out.conversations = c.pages;
      out.projects = c.projects;
      return out;
    } finally {
      await src.close().catch(() => undefined);
    }
  } catch (e) {
    return empty(kind, openProblem(e));
  }
}

export const notesDocs: ExtraImporterGroup = {
  name: "notesDocs",
  importers: { notion: new NotionImporter() as unknown as ExtraImporter, "google-docs": new GoogleDocsImporter() as unknown as ExtraImporter },
  inspectors: [notionInspector, googleDocsInspector],
};
