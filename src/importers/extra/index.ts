/**
 * The one place importer packages plug into the registry. registry.ts spreads `extraImporters()` into its table, so
 * a package that adds an importer (an export of another chat service, a notes app, another agent's CLI logs) adds
 * a file next to this one and names it in EXTRA_GROUPS below; registry.ts never changes again.
 *
 * A group is a plain object: `importers` maps a selector kind (the `kind` of its SourceSelector variant in
 * shared/protocol/runner.ts) to the importer. Groups live in chatExports.ts (conversation exports), notesDocs.ts
 * (notes and documents apps) and agentCli.ts (other coding agents' session logs); each starts empty.
 * Archive sources that need an export also get a line in shared/exportDue.ts and wording in ui/copy.ts
 * (addSources.sources) so the Add to your record sheet lists them with a how-to and "Request an export".
 */
import type { InspectResult, SourceSelector } from "../../shared/protocol/runner";
import type { ImportContext, Importer } from "../common";
import { openDocExport } from "../exportDocs";
import { captureGroup } from "../capture";
import { agentCli } from "./agentCli";
import { chatExports } from "./chatExports";
import { notesDocs } from "./notesDocs";

export type ExtraImporter = Importer<SourceSelector>;

export interface ExtraImporterGroup {
  /** For error messages only. */
  readonly name: string;
  /** Selector kind → importer. The importer's own `kind` must equal its key. */
  readonly importers: Readonly<Record<string, ExtraImporter>>;
  /** What `import.inspect` tries on an export the built-in services did not recognise. */
  readonly inspectors?: readonly ExtraInspector[];
}

export const EXTRA_GROUPS: readonly ExtraImporterGroup[] = [chatExports, notesDocs, agentCli, captureGroup];

/** Every extra importer by selector kind. A kind registered twice, or under the wrong key, is a programming error. */
export function extraImporters(groups: readonly ExtraImporterGroup[] = EXTRA_GROUPS): Record<string, ExtraImporter> {
  const out: Record<string, ExtraImporter> = {};
  for (const g of groups) {
    for (const [kind, imp] of Object.entries(g.importers)) {
      if (imp.kind !== kind) throw new Error(`importer group ${g.name}: "${kind}" holds an importer of kind "${imp.kind}"`);
      if (Object.hasOwn(out, kind)) throw new Error(`importer group ${g.name}: kind "${kind}" is already registered`);
      out[kind] = imp;
    }
  }
  return out;
}

/**
 * Recognises a dropped export of one extra service for `import.inspect`. Called only after the built-in services
 * did not recognise the export, with its member names; `inspect` returns the preview (counts only; no text) in the
 * shape the Add to your record sheet shows. `kind` is the SourceSelector kind and the sheet's source id.
 */
export interface ExtraInspector {
  readonly kind: string;
  recognise(memberNames: readonly string[]): boolean;
  /** null: the names fitted but the content does not (a lone .json could be any of several exports); the next inspector is tried. */
  inspect(file: string, ctx: ImportContext): Promise<InspectResult | null>;
}

/** The first extra inspector that recognises the export; null when none does. */
export async function inspectExtra(file: string, memberNames: readonly string[], ctx: ImportContext, groups: readonly ExtraImporterGroup[] = EXTRA_GROUPS): Promise<InspectResult | null> {
  const hits = (names: readonly string[]): ExtraInspector[] => groups.flatMap((g) => g.inspectors ?? []).filter((i) => i.recognise(names));
  const firstOf = async (names: readonly string[]): Promise<InspectResult | null> => {
    for (const i of hits(names)) {
      const r = await i.inspect(file, ctx);
      if (r) return r;
    }
    return null;
  };
  const first = await firstOf(memberNames);
  if (first) return first;
  // A zip of zip parts (a big Notion export): look inside the parts.
  if (memberNames.length > 0 && memberNames.every((n) => /\.zip$/i.test(n))) {
    let inner: string[] = [];
    try {
      const src = await openDocExport(file);
      inner = src.members.map((m) => m.name);
      await src.close().catch(() => undefined);
    } catch {
      return null;
    }
    return firstOf(inner);
  }
  return null;
}
