/**
 * What the agents' pending work is, in groups a person reads at a glance ("840 notes in Game Notes V2"): the vault's
 * notes by their top folder (with the biggest subfolders inside), wiki notes by area, chats to label, chat summaries and
 * area maps. Reads the planner's own catalogue (already built while counting the work); never calls a model.
 * Owner: E8 (agents).
 */
import type { PendingGroup } from "../shared/protocol/runner";
import { spaceName } from "../shared/spaces";
import type { JobKind, SpaceId } from "../shared/types";
import { loadJobData, wikiNotes, type JobContext, type JobData } from "./jobs";

/** At most this many subfolder names describe a folder's group. */
export const INSIDE_NAMES = 2;

type Targets = Partial<Record<JobKind, readonly string[]>>;

/** Group pending targets by what they are and where they live, biggest group first. */
export function groupTargets(byJob: Targets, data: Pick<JobData, "entries" | "conversations">, wiki: readonly { id: string; space: SpaceId }[] = []): PendingGroup[] {
  const wikiSpace = new Map<string, SpaceId>(wiki.map((w) => [w.id, w.space]));
  const groups = new Map<string, { g: PendingGroup; inside: Map<string, number> }>();
  const add = (key: string, base: Omit<PendingGroup, "n">, sub?: string): void => {
    let cur = groups.get(key);
    if (!cur) {
      cur = { g: { ...base, n: 0 }, inside: new Map() };
      groups.set(key, cur);
    }
    cur.g.n++;
    if (sub !== undefined) cur.inside.set(sub, (cur.inside.get(sub) ?? 0) + 1);
  };
  for (const t of byJob.label ?? []) {
    const e = data.entries.get(t);
    if (e) {
      const top = e.folder[0] ?? "Vault";
      add(`notes|${top}`, { what: "notes", where: top }, e.folder[1]);
    } else if (data.conversations.has(t)) add("chats", { what: "chats" });
    else {
      const space = wikiSpace.get(t);
      if (space !== undefined) add(`wiki|${space}`, { what: "wiki", where: spaceName(space) });
      else add("other", { what: "other" });
    }
  }
  for (let i = 0; i < (byJob.gist?.length ?? 0); i++) add("summaries", { what: "summaries" });
  for (let i = 0; i < (byJob.hub?.length ?? 0); i++) add("maps", { what: "maps" });
  const out: { key: string; g: PendingGroup }[] = [];
  for (const [key, { g, inside }] of groups) {
    if (inside.size > 0) {
      g.inside = [...inside].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, INSIDE_NAMES).map(([name]) => name);
      g.insideTotal = inside.size;
    }
    out.push({ key, g });
  }
  return out.sort((a, b) => b.g.n - a.g.n || a.key.localeCompare(b.key)).map((x) => x.g);
}

/** The groups of the pending label, summary and map targets, from the catalogue the planner just used. */
export async function describePending(byJob: Targets, ctx: JobContext): Promise<PendingGroup[]> {
  const data = await loadJobData(ctx);
  const unknown = (byJob.label ?? []).some((t) => !data.entries.has(t) && !data.conversations.has(t));
  return groupTargets(byJob, data, unknown ? await wikiNotes(ctx) : []);
}
