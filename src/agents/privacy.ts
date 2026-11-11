/**
 * What may leave the machine. Owner: E5. The RUNNER is the single enforcement point (H10): job inputs and Ask
 * candidates are read and filtered in the runner, never in the plugin.
 *  1. Left-out material is not opened: exclude fixes (entry, conversation, source, folder, project), the
 *     settings exclusions and the Off limits list (entryBlock / noteBlock below; importers skip it at import).
 *     Reference material and Ask history are never sent unless the matching setting allows it.
 *  2. Assistant replies withheld per source: for ChatGPT and Gemini (default) only what you typed there is sent;
 *     every other speaker's line becomes WITHHELD_REPLY so turn order stays visible.
 *  3. Redaction before sending, applied to EVERY field that leaves the machine — text, titles, map comments,
 *     Ask questions and history, vocabulary, filing items (SAFE-06): keys and tokens (shared/secrets.ts, with
 *     the entropy detector), card numbers, bank accounts, national IDs, addresses, birth dates and listed names
 *     (shared/personDetail.ts), email addresses, phone numbers and the user's own patterns.
 *  4. Every call logs a ReadRecord first (which entries, which policy, how many redactions and withheld lines):
 *     buildReadRecord, written before the engine call; the GuardedEngine refuses a call whose run has none.
 * User patterns are compiled defensively: at most 200 characters, no nested quantifiers or back-references (a
 * catastrophic pattern would stall every call), and a pattern that can match the empty string never inserts
 * markers between characters.
 */
import type { CortexSettings } from "../shared/settings";
import { allowedKeys, screenPersonDetails, type PersonScreenOptions } from "../shared/personDetail";
import { REDACTED_SECRET, scanSecrets } from "../shared/secrets";
import type { ConversationRecord, CorrectionRecord, EngineKind, EntryId, EntryRecord, NoteId, NoteRecord, ReadRecord, RunId, SourceKind, Speaker } from "../shared/types";

export interface PrivacyPolicy {
  name: string;
  withholdAssistant: boolean;
  redactSecrets: boolean;
  redactEmails: boolean;
  redactPhones: boolean;
  /** Card numbers, bank accounts, IDs, addresses, birth dates, listed names (shared/personDetail.ts). */
  redactPerson?: boolean;
  person?: PersonScreenOptions;
  extra: RegExp[];
}

/** Placeholder for an assistant reply that is never sent to a model (never adapted product copy). */
export const WITHHELD_REPLY = "[assistant reply withheld from models]";

/** Markers put in place of redacted spans in text sent to a model. */
export const REDACTION_MARKERS = {
  secret: REDACTED_SECRET,
  email: "[email removed]",
  phone: "[phone removed]",
  custom: "[private removed]",
} as const;

export const MAX_USER_PATTERN_CHARS = 200;

/**
 * A user pattern is used only when it cannot stall the runner: bounded length, no back-references, and no
 * repeated group that holds a quantifier or an alternation ("(a+)+", "(\w*)*", "(a|ab)*", "(x|y){2,}"), the
 * shapes behind catastrophic backtracking. An optional group ("(-\d+)?") is fine.
 */
export function isSafeUserPattern(p: string): boolean {
  if (p.length === 0 || p.length > MAX_USER_PATTERN_CHARS) return false;
  if (/\\[1-9]|\\k</.test(p)) return false;
  // Neutralise escapes and character classes, then walk the groups.
  const flat = p.replace(/\\./g, "x").replace(/\[(?:\\.|[^\]\\])*\]/g, "x");
  const stack: { quant: boolean; alt: boolean }[] = [];
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    const top = stack[stack.length - 1];
    if (ch === "(") stack.push({ quant: false, alt: false });
    else if (ch === "|") {
      if (top) top.alt = true;
    } else if (ch === ")") {
      const group = stack.pop();
      if (!group) return false;
      const next = flat[i + 1];
      const repeated = next === "*" || next === "+" || next === "{";
      if (repeated && (group.quant || group.alt)) return false;
      const parent = stack[stack.length - 1];
      if (parent && (group.quant || repeated)) parent.quant = true;
    } else if ((ch === "*" || ch === "+" || ch === "{") && top) top.quant = true;
  }
  return stack.length === 0;
}

/** Compile the user's patterns ("Remove before sending" custom rows); unsafe or invalid ones are skipped. */
export function compileUserPatterns(patterns: readonly string[]): { res: RegExp[]; skipped: number } {
  const res: RegExp[] = [];
  let skipped = 0;
  for (const pat of patterns) {
    if (typeof pat !== "string" || !isSafeUserPattern(pat)) {
      skipped++;
      continue;
    }
    try {
      res.push(new RegExp(pat, "gu"));
    } catch {
      try {
        res.push(new RegExp(pat, "g"));
      } catch {
        skipped++;
      }
    }
  }
  return { res, skipped };
}

/** Policy name recorded on ReadRecords: what was withheld and whether anything is redacted. */
export function policyName(withholdAssistant: boolean, redacts: boolean): string {
  const base = withholdAssistant ? "replies-withheld" : "full";
  return redacts ? `${base}+redacted` : base;
}

export function policyFor(source: SourceKind, settings: CortexSettings): PrivacyPolicy {
  const p = settings.privacy;
  const withhold = p.withholdAssistantFrom[source] === true;
  const { res } = compileUserPatterns(p.redact.custom);
  const redacts = p.redact.secrets || p.redact.emails || p.redact.phones || p.redact.personal || res.length > 0;
  const sc = p.screening;
  const person: PersonScreenOptions = { idCountries: sc.idCountries, names: sc.names, allowed: allowedKeys(sc.allowed), ...(sc.salt ? { salt: sc.salt } : {}) };
  return { name: policyName(withhold, redacts), withholdAssistant: withhold, redactSecrets: p.redact.secrets, redactEmails: p.redact.emails, redactPhones: p.redact.phones, redactPerson: p.redact.personal, person, extra: res };
}

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;
const PHONE = /(?<![\w.])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w.])/g;

export function redact(text: string, policy: PrivacyPolicy): { text: string; redactions: number } {
  let n = 0;
  let out = text;
  if (out.length === 0) return { text: out, redactions: 0 };
  if (policy.redactSecrets) {
    const s = scanSecrets(out, { highConfidenceOnly: false, replacement: REDACTION_MARKERS.secret });
    out = s.text;
    n += s.count;
  }
  let restore = (t: string): string => t;
  if (policy.redactPerson) {
    const r = screenPersonDetails(out, { ...policy.person, hold: true });
    out = r.text;
    n += r.count;
    restore = r.restore;
  }
  const sub = (re: RegExp, marker: string) => {
    re.lastIndex = 0;
    out = out.replace(re, (m: string) => {
      if (m.length === 0) return m;
      n++;
      return marker;
    });
  };
  if (policy.redactEmails) sub(EMAIL, REDACTION_MARKERS.email);
  if (policy.redactPhones) sub(PHONE, REDACTION_MARKERS.phone);
  for (const re of policy.extra) sub(re, REDACTION_MARKERS.custom);
  return { text: restore(out), redactions: n };
}

export interface CloudItem {
  speaker: Speaker;
  text: string;
  title?: string;
}

/** Apply withholding and redaction (to text AND title); withheld lines keep their place in the turn order. */
export function prepareForCloud<T extends CloudItem>(items: readonly T[], policy: PrivacyPolicy): { items: T[]; redactions: number; withheld: number } {
  let redactions = 0;
  let withheld = 0;
  const out = items.map((it) => {
    const title = it.title === undefined ? undefined : redact(it.title, policy);
    if (title) redactions += title.redactions;
    if (policy.withholdAssistant && it.speaker !== "you") {
      withheld++;
      return { ...it, text: WITHHELD_REPLY, ...(title ? { title: title.text } : {}) };
    }
    const r = redact(it.text, policy);
    redactions += r.redactions;
    return { ...it, text: r.text, ...(title ? { title: title.text } : {}) };
  });
  return { items: out, redactions, withheld };
}

/** Redact free-standing strings that leave the machine (Ask questions, history, comments, vocabulary values). */
export function redactAll(values: readonly string[], policy: PrivacyPolicy): { values: string[]; redactions: number } {
  let n = 0;
  const out = values.map((v) => {
    const r = redact(v, policy);
    n += r.redactions;
    return r.text;
  });
  return { values: out, redactions: n };
}

/** Redact every value of a vocabulary map (Ask context: area names, folders, label values). */
export function redactVocabulary(vocab: Readonly<Record<string, readonly string[]>>, policy: PrivacyPolicy): { vocabulary: Record<string, string[]>; redactions: number } {
  let n = 0;
  const out: Record<string, string[]> = {};
  for (const [k, vs] of Object.entries(vocab)) {
    const r = redactAll(vs, policy);
    n += r.redactions;
    out[k] = r.values;
  }
  return { vocabulary: out, redactions: n };
}

/** Policy used for strings that belong to no source (questions, comments): redaction only, nothing withheld. */
export function textPolicy(settings: CortexSettings): PrivacyPolicy {
  return { ...policyFor("cortex-ask", settings), withholdAssistant: false, name: policyName(false, true) };
}

/** One name for the policies applied in one call ("full+redacted", or several joined by a comma). */
export function combinedPolicyName(names: Iterable<string>): string {
  const set = [...new Set(names)].sort();
  return set.length === 0 ? policyName(false, false) : set.join(",");
}

export interface ReadRecordArgs {
  runId: RunId;
  model: string;
  engine: EngineKind;
  where: "remote" | "this computer";
  entryIds: readonly EntryId[];
  noteIds: readonly NoteId[];
  policy: string;
  chars: number;
  redactions: number;
  withheld: number;
  via: "job" | "ask";
  origin: "plugin" | "skill";
  promptVersion?: string;
  at?: string;
}

/** The access-log line for one model call (written BEFORE the call). */
export function buildReadRecord(a: ReadRecordArgs): ReadRecord {
  const rec: ReadRecord = {
    v: 1,
    runId: a.runId,
    model: a.model,
    engine: a.engine,
    where: a.where,
    entryIds: [...new Set(a.entryIds)],
    noteIds: [...new Set(a.noteIds)],
    policy: a.policy,
    chars: Math.max(0, Math.floor(a.chars)),
    redactions: Math.max(0, Math.floor(a.redactions)),
    withheld: Math.max(0, Math.floor(a.withheld)),
    via: a.via,
    origin: a.origin,
    at: a.at ?? new Date().toISOString(),
  };
  if (a.promptVersion !== undefined) rec.promptVersion = a.promptVersion;
  return rec;
}

// ───────────────────────────── leaving out (runner-side check) ─────────────────────────────

type ExcludePayload = CorrectionRecord<"exclude">["payload"];

/** What the fixes say about reading: left-out targets and scopes, current wording, corrected speakers. */
export interface PrivacyFold {
  /** target id → exclude payload (entry, conversation, source, folder or project scope). */
  excluded: Map<string, ExcludePayload>;
  sources: Set<string>;
  folders: string[];
  projects: Set<string>;
  /** entry id → its latest user wording (edit-text fixes not withdrawn). */
  edits: Map<string, { version: number; text: string }>;
  /** entry id → corrected speaker. */
  speakers: Map<string, Speaker>;
}

const normFolder = (f: string): string => f.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Fold the fixes log for reading decisions. A fix named by a later fix's `undoes` is withdrawn (an undo of an
 * undo restores it); "include" brings back what an "exclude" left out. Order = log order.
 */
export function foldForPrivacy(records: readonly CorrectionRecord[]): PrivacyFold {
  const withdrawn = new Set<string>();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as CorrectionRecord;
    if (withdrawn.has(r.id)) continue;
    if (r.undoes) withdrawn.add(r.undoes);
  }
  const fold: PrivacyFold = { excluded: new Map(), sources: new Set(), folders: [], projects: new Set(), edits: new Map(), speakers: new Map() };
  const byId = new Map<string, { target: string; payload: ExcludePayload }>();
  for (const r of records) {
    if (withdrawn.has(r.id) || r.undoes) continue;
    switch (r.action) {
      case "exclude": {
        const payload = r.payload as ExcludePayload;
        fold.excluded.set(r.target, payload);
        byId.set(r.id, { target: r.target, payload });
        break;
      }
      case "include": {
        const p = r.payload as CorrectionRecord<"include">["payload"];
        const ex = byId.get(p.excludeCorrectionId);
        fold.excluded.delete(ex?.target ?? r.target);
        break;
      }
      case "edit-text": {
        const p = r.payload as CorrectionRecord<"edit-text">["payload"];
        const cur = fold.edits.get(r.target);
        if (!cur || p.version >= cur.version) fold.edits.set(r.target, { version: p.version, text: p.newText });
        break;
      }
      case "set-speaker":
        fold.speakers.set(r.target, (r.payload as CorrectionRecord<"set-speaker">["payload"]).speaker);
        break;
      default:
        break;
    }
  }
  for (const [target, p] of fold.excluded) {
    if (p.scope === "source") fold.sources.add(p.sourceKind ?? target);
    else if (p.scope === "folder") fold.folders.push(normFolder(p.folder ?? target));
    else if (p.scope === "project") fold.projects.add(p.project ?? target);
  }
  return fold;
}

/** On the Off limits list (fixed rows are enforced by the importers; these are the user's own rows). */
export function isOffLimits(location: string, settings: CortexSettings): boolean {
  const loc = normFolder(location);
  if (loc.length === 0) return false;
  return settings.privacy.offLimits.some((row) => {
    const p = normFolder(row.path);
    return p.length > 0 && (loc === p || loc.startsWith(`${p}/`));
  });
}

function underFolder(location: string, folders: readonly string[]): boolean {
  const loc = normFolder(location);
  return folders.some((f) => f.length > 0 && (loc === f || loc.startsWith(`${f}/`)));
}

export type BlockReason = "left-out" | "off-limits" | "reference" | "ask-history" | "hidden" | "automated";

/**
 * Why an entry may not be sent, or undefined when it may. `conv` is its conversation record when known.
 * Hidden-by-default material (subagents, harness lines, tool output, automated sessions) is sent only when the
 * matching import setting brought it in on purpose.
 */
export function entryBlock(entry: EntryRecord, conv: ConversationRecord | undefined, fold: PrivacyFold, settings: CortexSettings): BlockReason | undefined {
  if (fold.excluded.has(entry.id)) return "left-out";
  if (entry.conv && fold.excluded.has(entry.conv)) return "left-out";
  if (fold.sources.has(entry.source)) return "left-out";
  const slug = conv?.meta?.projectSlug;
  const projects = [entry.project, conv?.project, slug].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (projects.some((p) => fold.projects.has(p))) return "left-out";
  if (slug && settings.sources.claudeCode.excludeProjects.includes(slug)) return "left-out";
  const folderPath = entry.folder.join("/");
  if (underFolder(folderPath, fold.folders) || underFolder(entry.sourceRef.path, fold.folders)) return "left-out";
  const excludedVaultFolders = [...settings.sources.vault.excludeFolders, ...settings.sources.raw.excludeFolders].map(normFolder);
  if (entry.source === "files" || entry.source === "obsidian") {
    if (underFolder(entry.sourceRef.path, excludedVaultFolders)) return "left-out";
  }
  if (isOffLimits(entry.sourceRef.path, settings)) return "off-limits";
  switch (entry.hiddenByDefault) {
    case "cortex-ask":
      return "ask-history";
    case "reference":
      return settings.agents.skipReference ? "reference" : undefined;
    case "subagent":
      return settings.sources.claudeCode.includeSubagents ? undefined : "hidden";
    case "tool":
      return settings.sources.claudeCode.includeToolOutput ? undefined : "hidden";
    case "harness":
      return "hidden";
    case "automated":
      return "automated";
    default:
      break;
  }
  if (entry.source === "cortex-ask") return "ask-history";
  return undefined;
}

/** Why a machine note may not be sent, or undefined when it may. */
export function noteBlock(note: NoteRecord, fold: PrivacyFold, settings: CortexSettings): BlockReason | undefined {
  if (note.state === "excluded") return "left-out";
  if (note.state === "hidden") return "hidden";
  if (fold.excluded.has(note.id)) return "left-out";
  if (note.conv && fold.excluded.has(note.conv)) return "left-out";
  if (isOffLimits(note.file, settings)) return "off-limits";
  if (underFolder(note.file, fold.folders)) return "left-out";
  return undefined;
}

/** A legacy vault note (vault path + whether its frontmatter says status: reference). */
export function vaultNoteBlock(vaultPath: string, isReference: boolean, fold: PrivacyFold, settings: CortexSettings): BlockReason | undefined {
  if (underFolder(vaultPath, settings.sources.vault.excludeFolders.map(normFolder))) return "left-out";
  if (underFolder(vaultPath, fold.folders)) return "left-out";
  if (isOffLimits(vaultPath, settings)) return "off-limits";
  if (isReference && settings.agents.skipReference) return "reference";
  return undefined;
}

/** The speaker to apply withholding to: the user's fix wins over the imported speaker. */
export function effectiveSpeaker(entry: Pick<EntryRecord, "id" | "speaker">, fold: PrivacyFold): Speaker {
  return fold.speakers.get(entry.id) ?? entry.speaker;
}
