/**
 * "Screened on this computer": what the privacy filter would replace in the text that may be sent to a model, counted
 * per kind, with the values in masked form and the text around each one shown with its replacement. Read-only: it
 * opens the same entries the jobs would (left-out, off-limits and withheld replies are skipped), runs the same
 * detectors (shared/personDetail.ts) and writes nothing. The optional local-model pass only PROPOSES names and
 * addresses; nothing is added to the screen until the person confirms it. Owner: screening-person.
 */
import type { CortexSettings } from "../shared/settings";
import { allowedKeys, ScreenTally, type PersonScreenOptions, type ScreenedSummary } from "../shared/personDetail";
import { currentText, loadJobData, visibleForJobs, type JobContext } from "./jobs";
import { proposePersonDetails } from "./localEngine";
import type { Engine } from "./engine";

export const SCAN_MAX_ENTRIES = 40_000;
export const SCAN_MAX_MS = 8_000;
export const SCAN_MAX_ITEMS = 300;
const CONTEXT_CHARS = 36;
const PROPOSAL_ENTRIES = 24;
const PROPOSAL_CHARS = 1_400;

/** The detector options a settings object stands for (what agents/privacy.ts builds for a call). */
export function personOptionsOf(settings: CortexSettings): PersonScreenOptions {
  const sc = settings.privacy.screening;
  return { idCountries: sc.idCountries, names: sc.names, allowed: allowedKeys(sc.allowed), salt: sc.salt };
}

export interface ScanArgs {
  /** Ask the local model for names and addresses too (needs the engine on this computer and the setting on). */
  proposeNames?: boolean;
  engine?: Engine | null;
  maxEntries?: number;
  maxMs?: number;
  now?: () => number;
}

/** Look through the entries that may leave this computer and say what would be replaced. */
export async function scanScreened(ctx: JobContext, args: ScanArgs = {}): Promise<ScreenedSummary> {
  const settings = ctx.settings;
  const empty: ScreenedSummary = { scanned: 0, total: 0, partial: false, kinds: [], items: [] };
  if (!settings.privacy.redact.personal && settings.privacy.screening.names.length === 0) return { ...empty, off: true };
  const now = args.now ?? Date.now;
  const t0 = now();
  const maxMs = args.maxMs ?? SCAN_MAX_MS;
  const maxEntries = args.maxEntries ?? SCAN_MAX_ENTRIES;
  const data = await loadJobData(ctx);
  const opts = personOptionsOf(settings);
  const off = settings.privacy.redact.personal ? undefined : ({ card: true, bank: true, id: true, address: true, birth: true } as const);
  const screen: PersonScreenOptions = off ? { ...opts, off } : opts;

  const tally = new ScreenTally(screen, SCAN_MAX_ITEMS, CONTEXT_CHARS);
  const sample: string[] = [];
  let scanned = 0;
  let total = 0;
  let partial = false;
  // Newest first: what was written lately is what a model is most likely to be sent.
  const list = [...data.entries.values()].reverse();
  for (const e of list) {
    if (!visibleForJobs(e, data, settings)) continue;
    const speaker = data.corrections.speakers.get(e.id) ?? e.speaker;
    if (settings.privacy.withholdAssistantFrom[e.source] === true && speaker !== "you") continue;
    total++;
    if (partial) continue;
    if (scanned >= maxEntries || (scanned % 100 === 0 && now() - t0 > maxMs)) {
      partial = true;
      continue;
    }
    if (scanned % 100 === 0) ctx.token.throwIfCancelled();
    scanned++;
    const t = await currentText(ctx, data, e);
    if (!t || t.text.length < 5) continue;
    const text = t.text;
    if (args.proposeNames && sample.length < PROPOSAL_ENTRIES && speaker === "you" && text.length >= 60) sample.push(text.slice(0, PROPOSAL_CHARS));
    tally.add(e.id, text);
  }
  const out: ScreenedSummary = tally.summary(scanned, total, partial);
  if (args.proposeNames && settings.privacy.screening.localNames && args.engine && sample.length > 0) {
    const known = new Set(settings.privacy.screening.names.map((n) => n.replace(/^address:/, "").toLowerCase()));
    try {
      out.proposals = await proposePersonDetails(args.engine, sample, { model: settings.agents.local.model, signal: ctx.token.signal, known });
    } catch {
      out.proposals = [];
    }
  }
  return out;
}
