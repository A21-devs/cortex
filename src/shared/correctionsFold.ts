/**
 * The corrections fold: the user outranks models. Owner: E7. Pure (runs in the runner's index builder and in the
 * plugin's live overlay, so both always agree).
 *
 * `foldCorrections` turns the append-only corrections log into the effective state. A correction with `undoes`
 * cancels the correction it names (an undo of an undo restores it). Order = log order.
 *
 * Versions (SAFE-13): an edit's version number is assigned when the correction is WRITTEN (payload.version =
 * max existing + 1, under the corrections lock) and folding keeps it; an undo withdraws that version without
 * renumbering later ones, so citations (entry, version, quote) never move.
 *
 * Exclusions (M2): one rule for every scope (entry, conversation, source, folder, project). `exclusionMatcher`
 * answers it for an entry. Importers skip anything covered by an exclude of scope conversation or wider.
 *
 * Pins (M15): pin / unpin corrections, folded into ItemFlag.Pinned.
 */
import type { MergeMap } from "./protocol/worker";
import type { CorrectionId, CorrectionRecord, CorrectionVia, IsoDate, LabelValue, SourceKind, SpaceId, Speaker } from "./types";

export type ExcludeScope = CorrectionRecord<"exclude">["payload"]["scope"];

export interface ExcludeRule {
  scope: ExcludeScope;
  /** The exclude correction (what "Bring back" undoes). */
  by: CorrectionId;
  sourceKind?: SourceKind;
  folder?: string;
  project?: string;
}

export interface EffectiveCorrections {
  /** target → rule. Entry and conversation scopes are keyed by the entry or conversation id; the wider scopes by
   *  the correction's own target (a source kind, a folder path or a project name). */
  excluded: Map<string, ExcludeRule>;
  /** entry id → user versions with their text, in version order (gaps allowed after undo). */
  edits: Map<string, { version: number; text: string; sha256: string; at: IsoDate; by: CorrectionId; via: CorrectionVia }[]>;
  merges: MergeMap;
  refiles: Map<string, { space?: SpaceId; folder?: string[]; project?: string | null }>;
  speakers: Map<string, { speaker: Speaker; speakerDetail?: string }>;
  dates: Map<string, IsoDate | null>;
  /** `${target}|${pack}|${field}` → user value. */
  userLabels: Map<string, LabelValue>;
  rejectedLabels: Set<string>;
  confirmedLabels: Set<string>;
  /** target (gist, atomic note or map) → comments. */
  comments: Map<string, { id: CorrectionId; text: string; resolved: boolean }[]>;
  pinned: Set<string>;
}

/** Ids of corrections withdrawn by an undo that itself stands (walk backwards: an undo of an undo restores). */
export function undoneIds(records: readonly CorrectionRecord[]): Set<string> {
  const undone = new Set<string>();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as CorrectionRecord;
    if (undone.has(r.id)) continue;
    if (r.undoes) undone.add(r.undoes);
  }
  return undone;
}

export function emptyCorrections(): EffectiveCorrections {
  return {
    excluded: new Map(),
    edits: new Map(),
    merges: {},
    refiles: new Map(),
    speakers: new Map(),
    dates: new Map(),
    userLabels: new Map(),
    rejectedLabels: new Set(),
    confirmedLabels: new Set(),
    comments: new Map(),
    pinned: new Set(),
  };
}

export function foldCorrections(records: readonly CorrectionRecord[]): EffectiveCorrections {
  const undone = undoneIds(records);
  const eff = emptyCorrections();
  /** merge correction id → where it wrote, so a split-group can take exactly that merge back. */
  const mergeAt = new Map<string, { dim: string; from: string }>();
  for (const r of records) {
    if (undone.has(r.id) || r.undoes) continue;
    switch (r.action) {
      case "exclude": {
        const p = r.payload as CorrectionRecord<"exclude">["payload"];
        const rule: ExcludeRule = { scope: p.scope, by: r.id };
        if (p.sourceKind !== undefined) rule.sourceKind = p.sourceKind;
        if (p.folder !== undefined) rule.folder = p.folder;
        if (p.project !== undefined) rule.project = p.project;
        eff.excluded.set(r.target, rule);
        break;
      }
      case "include": {
        const p = r.payload as CorrectionRecord<"include">["payload"];
        for (const [k, rule] of eff.excluded) if (rule.by === p.excludeCorrectionId) eff.excluded.delete(k);
        break;
      }
      case "edit-text": {
        const p = r.payload as CorrectionRecord<"edit-text">["payload"];
        const list = eff.edits.get(r.target) ?? [];
        list.push({ version: p.version, text: p.newText, sha256: p.newTextSha256, at: r.at, by: r.id, via: r.via });
        list.sort((a, b) => a.version - b.version);
        eff.edits.set(r.target, list);
        break;
      }
      case "merge-groups": {
        const p = r.payload as CorrectionRecord<"merge-groups">["payload"];
        (eff.merges[p.dim] ??= {})[p.from] = p.as ?? p.into;
        mergeAt.set(r.id, { dim: p.dim, from: p.from });
        break;
      }
      case "split-group": {
        const p = r.payload as CorrectionRecord<"split-group">["payload"];
        const at = mergeAt.get(p.mergeCorrectionId);
        const m = at ? eff.merges[at.dim] : undefined;
        if (at && m) {
          delete m[at.from];
          if (Object.keys(m).length === 0) delete eff.merges[at.dim];
        }
        break;
      }
      case "refile":
        eff.refiles.set(r.target, r.payload as CorrectionRecord<"refile">["payload"]);
        break;
      case "set-speaker":
        eff.speakers.set(r.target, r.payload as CorrectionRecord<"set-speaker">["payload"]);
        break;
      case "set-date":
        eff.dates.set(r.target, (r.payload as CorrectionRecord<"set-date">["payload"]).writtenAt);
        break;
      case "set-label": {
        const p = r.payload as CorrectionRecord<"set-label">["payload"];
        eff.userLabels.set(`${r.target}|${p.pack}|${p.field}`, p.value);
        break;
      }
      case "reject-label":
        eff.rejectedLabels.add((r.payload as CorrectionRecord<"reject-label">["payload"]).labelId);
        break;
      case "confirm": {
        const p = r.payload as CorrectionRecord<"confirm">["payload"];
        if (p.labelId) eff.confirmedLabels.add(p.labelId);
        break;
      }
      case "comment": {
        const list = eff.comments.get(r.target) ?? [];
        list.push({ id: r.id, text: (r.payload as CorrectionRecord<"comment">["payload"]).text, resolved: false });
        eff.comments.set(r.target, list);
        break;
      }
      case "resolve-comment": {
        const p = r.payload as CorrectionRecord<"resolve-comment">["payload"];
        for (const list of eff.comments.values()) for (const c of list) if (c.id === p.commentId) c.resolved = true;
        break;
      }
      case "pin":
        eff.pinned.add(r.target);
        break;
      case "unpin":
        eff.pinned.delete(r.target);
        break;
    }
  }
  return eff;
}

/** The next version number for an entry: max of every version ever written (undone ones included) + 1. */
export function nextVersion(records: readonly CorrectionRecord[], entryId: string): number {
  let max = 1;
  for (const r of records) {
    if (r.action === "edit-text" && r.target === entryId) max = Math.max(max, (r.payload as CorrectionRecord<"edit-text">["payload"]).version);
  }
  return max + 1;
}

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
const under = (p: string, prefix: string): boolean => {
  const a = norm(p);
  const b = norm(prefix);
  return b.length > 0 && (a === b || a.startsWith(`${b}/`));
};

/** What the matcher needs to know about an entry. */
export interface ExclusionFacts {
  id: string;
  conv?: string;
  source: SourceKind;
  project?: string;
  /** Vault path or original path of the unit. */
  path?: string;
  folder: readonly string[];
}

/** One rule for every scope; returns the exclude rule that covers the entry, or null. */
export function exclusionMatcher(eff: EffectiveCorrections): (f: ExclusionFacts) => ExcludeRule | null {
  const wide: [string, ExcludeRule][] = [];
  for (const [target, rule] of eff.excluded) if (rule.scope === "source" || rule.scope === "folder" || rule.scope === "project") wide.push([target, rule]);
  return (f) => {
    const direct = eff.excluded.get(f.id) ?? (f.conv !== undefined ? eff.excluded.get(f.conv) : undefined);
    if (direct && (direct.scope === "entry" || direct.scope === "conversation")) return direct;
    for (const [target, rule] of wide) {
      if (rule.scope === "source") {
        if ((rule.sourceKind ?? target) === f.source) return rule;
      } else if (rule.scope === "project") {
        const name = (rule.project ?? target).toLowerCase();
        if (f.project !== undefined && f.project.toLowerCase() === name) return rule;
      } else {
        const folder = rule.folder ?? target;
        if (f.path !== undefined && under(f.path, folder)) return rule;
        if (f.folder.length > 0 && under(f.folder.join("/"), folder)) return rule;
      }
    }
    return null;
  };
}
