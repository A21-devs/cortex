/**
 * Your resume (Add sources › Your resume): the pure part. A resume is a separate document, never a record entry.
 * Cortex splits its text into claims (a role line, a bullet, one skill) and checks each against what the record
 * shows, by searching the record's own words on this computer. No model reads the resume, so nothing leaves the
 * computer. A claim is Supported when one search for all its key terms finds entries, Partly supported when only
 * some of its terms are found, and Not found otherwise; each verdict names the entries it rests on.
 */

import type { ReadonlySignal } from "@preact/signals-core";

export const RESUME_MAX_CHARS = 60_000;
export const RESUME_MAX_BYTES = 8 * 1024 * 1024;
export const RESUME_MAX_CLAIMS = 60;
export const RESUME_CLAIM_MAX_CHARS = 240;
export const RESUME_EXTENSIONS = ["pdf", "docx", "txt", "md"] as const;
export type ResumeExtension = (typeof RESUME_EXTENSIONS)[number];

export type ClaimVerdict = "supported" | "partly" | "not-found";
export type ResumeState = "queued" | "checking" | "done" | "failed";

export interface ClaimEntry {
  id: string;
  title: string;
}

export interface ClaimResult {
  text: string;
  verdict: ClaimVerdict;
  entries: ClaimEntry[];
}

export interface ResumeCheck {
  at: string;
  claims: ClaimResult[];
}

/** What is kept of an added resume (`.vault-meta/cortex/state/resume.json`): its text, never a record entry. */
export interface ResumeFile {
  v: 1;
  name: string;
  addedAt: string;
  chars: number;
  text: string;
  state: ResumeState;
  check?: ResumeCheck;
}

/** What the Add sources block and the Checks list need. */
export interface ResumeStatus {
  name: string;
  addedAt: string;
  state: ResumeState;
  /** When the last finished check ran. */
  checkedAt?: string;
  counts?: { supported: number; partly: number; notFound: number };
  claims?: ClaimResult[];
}

export interface ResumeService {
  /** Bumps whenever the stored resume or its check changes. */
  readonly version: ReadonlySignal<number>;
  status(): Promise<ResumeStatus | null>;
  /** Keep this file (pdf, docx, txt or md) as the resume and queue a claims check; it runs in the background unless `autoRun` is off. */
  add(file: string): Promise<ResumeStatus>;
  /** Check the claims again now; resolves when done. */
  check(): Promise<ResumeStatus | null>;
  remove(): Promise<void>;
}

export function resumeExtension(name: string): ResumeExtension | null {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  const e = m?.[1]?.toLowerCase();
  return (RESUME_EXTENSIONS as readonly string[]).includes(e ?? "") ? (e as ResumeExtension) : null;
}

const HEADINGS = new Set([
  "experience", "work experience", "professional experience", "employment", "employment history", "work history", "education", "skills", "technical skills", "key skills", "core skills", "summary", "professional summary", "profile", "about", "about me", "objective", "projects", "certifications", "certificates", "languages", "references", "interests", "awards", "publications", "contact", "volunteering", "courses", "achievements",
]);
const SKILL_HEADINGS = new Set(["skills", "technical skills", "key skills", "core skills", "tools", "technologies", "languages"]);
const WEAK = new Set([
  "of", "to", "in", "on", "at", "by", "an", "as", "is", "be", "it", "or", "we", "my", "me", "up", "so", "if", "and", "the", "for", "with", "from", "that", "this", "have", "has", "was", "were", "are", "our", "their", "also", "into", "over", "per", "via", "using", "used", "use", "managed", "led", "lead", "leading", "developed", "built", "worked", "working", "responsible", "team", "teams", "across", "within", "including", "various", "strong", "ability", "experience", "experienced", "skills", "skill", "years", "year", "present", "current", "company", "role", "work", "project", "projects", "improved", "delivered", "created", "designed", "implemented", "supported", "helped", "make", "made", "new", "all", "more", "based", "good", "great", "excellent", "knowledge", "proficient", "familiar", "senior", "junior", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** Job-title words: part of a role line, but a poor way to find it in the record. */
const TITLES = new Set(["engineer", "manager", "developer", "director", "analyst", "consultant", "designer", "officer", "specialist", "intern", "assistant", "head", "president", "founder", "architect", "scientist", "coordinator", "associate", "administrator", "software", "product", "corp", "inc", "ltd", "llc"]);

const CONTACT = /@|https?:\/\/|www\.|linkedin|github\.com|(?:\d[\s().-]*){9,}/i;

function cleanLine(raw: string): string {
  return raw
    .replace(/^[\s•·▪●–—*+>-]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isHeading(line: string): boolean {
  const k = line.replace(/[:\s]+$/, "").toLowerCase();
  return HEADINGS.has(k);
}

function looksLikeName(line: string): boolean {
  const words = line.split(" ");
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^\p{Lu}[\p{L}'.-]*$/u.test(w));
}

/** The key terms of a claim, best first: proper names and tokens with digits before longer plain words; no years. */
export function claimTerms(text: string): string[] {
  const seen = new Set<string>();
  const scored: { w: string; score: number; i: number }[] = [];
  let i = 0;
  for (const m of text.matchAll(/[\p{L}\p{N}]{2,40}/gu)) {
    const raw = m[0];
    const w = raw.toLowerCase();
    i++;
    if (seen.has(w) || WEAK.has(w) || /^(19|20)\d\d$/.test(w) || /^\d+$/.test(w)) continue;
    seen.add(w);
    const proper = /^\p{Lu}/u.test(raw) && i > 1;
    const tech = /\d/.test(w) || (/^\p{Lu}+$/u.test(raw) && raw.length <= 6);
    scored.push({ w, score: (proper ? 3 : 0) + (tech ? 3 : 0) + Math.min(raw.length, 12) / 12 - (TITLES.has(w) ? 5 : 0), i });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 4)
    .map((s) => s.w);
}

export interface ResumeClaimDraft {
  text: string;
  terms: string[];
}

/** Split a resume's text into the claims to check (at most RESUME_MAX_CLAIMS, in reading order). */
export function splitClaims(text: string): ResumeClaimDraft[] {
  const out: ResumeClaimDraft[] = [];
  const seen = new Set<string>();
  let skills = false;
  let first = true;
  const push = (t: string): void => {
    const s = t.length > RESUME_CLAIM_MAX_CHARS ? `${t.slice(0, RESUME_CLAIM_MAX_CHARS - 1).trimEnd()}…` : t;
    const key = s.toLowerCase();
    if (seen.has(key) || out.length >= RESUME_MAX_CLAIMS) return;
    const terms = claimTerms(s);
    if (terms.length === 0) return;
    seen.add(key);
    out.push({ text: s, terms });
  };
  for (const rawLine of text.slice(0, RESUME_MAX_CHARS).split(/\r?\n/)) {
    let line = cleanLine(rawLine);
    if (line.length === 0) continue;
    const wasFirst = first;
    first = false;
    if (isHeading(line)) {
      skills = SKILL_HEADINGS.has(line.replace(/[:\s]+$/, "").toLowerCase());
      continue;
    }
    if (wasFirst && looksLikeName(line)) continue;
    if (CONTACT.test(line)) continue;
    const label = /^([\p{L} ]{3,24}):\s*(.+)$/u.exec(line);
    let inSkills = skills;
    if (label && SKILL_HEADINGS.has((label[1] ?? "").toLowerCase())) {
      inSkills = true;
      line = label[2] ?? line;
    }
    if (inSkills) {
      for (const part of line.split(/[,;|•·]/)) {
        const p = cleanLine(part);
        if (p.length >= 2 && p.split(" ").length <= 5) push(p);
      }
      continue;
    }
    // A prose line may hold several sentences; each is its own claim.
    for (const sentence of line.split(/(?<=[.!?])\s+(?=\p{Lu})/u)) {
      const s = cleanLine(sentence).replace(/[.]+$/, "");
      if (s.split(" ").length >= 2) push(s);
    }
  }
  return out;
}

/** Searches the record on this computer for entries holding every one of these terms (best first, a few at most). */
export type RecordSearch = (terms: readonly string[]) => Promise<ClaimEntry[]>;

/** The verdict of one claim: Supported (all key terms found together), Partly (some found), else Not found. */
export async function judgeClaim(draft: ResumeClaimDraft, search: RecordSearch): Promise<ClaimResult> {
  const all = await search(draft.terms);
  if (all.length > 0) return { text: draft.text, verdict: "supported", entries: all.slice(0, 3) };
  const found = new Map<string, ClaimEntry>();
  let matched = 0;
  let strong = false;
  for (let i = 0; i < draft.terms.length; i++) {
    const term = draft.terms[i] as string;
    const hit = draft.terms.length === 1 ? all : await search([term]);
    if (hit.length === 0) continue;
    matched++;
    // The first term is the claim's most specific one (a name, a tool).
    if (i === 0) strong = true;
    for (const h of hit) if (!found.has(h.id)) found.set(h.id, h);
  }
  if (matched > 0 && (strong || matched >= 2)) return { text: draft.text, verdict: "partly", entries: [...found.values()].slice(0, 3) };
  return { text: draft.text, verdict: "not-found", entries: [] };
}

/** Run the whole check: one verdict per claim. `step` reports progress; `cancelled` stops early (the partial list is dropped by the caller). */
export async function checkClaims(text: string, search: RecordSearch, opts: { now?: () => number; step?: (done: number, total: number) => void; cancelled?: () => boolean } = {}): Promise<ResumeCheck> {
  const drafts = splitClaims(text);
  const claims: ClaimResult[] = [];
  for (let i = 0; i < drafts.length; i++) {
    if (opts.cancelled?.()) break;
    claims.push(await judgeClaim(drafts[i] as ResumeClaimDraft, search));
    opts.step?.(i + 1, drafts.length);
  }
  return { at: new Date((opts.now ?? Date.now)()).toISOString(), claims };
}

export function countVerdicts(claims: readonly ClaimResult[]): { supported: number; partly: number; notFound: number } {
  const c = { supported: 0, partly: 0, notFound: 0 };
  for (const x of claims) {
    if (x.verdict === "supported") c.supported++;
    else if (x.verdict === "partly") c.partly++;
    else c.notFound++;
  }
  return c;
}

/** The view of a stored resume (the text itself stays in the file). */
export function statusOf(f: ResumeFile): ResumeStatus {
  const base: ResumeStatus = { name: f.name, addedAt: f.addedAt, state: f.state };
  if (!f.check) return base;
  return { ...base, checkedAt: f.check.at, counts: countVerdicts(f.check.claims), claims: f.check.claims };
}

/** Narrow an untrusted parsed file to a ResumeFile, or null. */
export function parseResumeFile(raw: unknown): ResumeFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.name !== "string" || typeof r.addedAt !== "string" || typeof r.text !== "string") return null;
  const state: ResumeState = r.state === "queued" || r.state === "checking" || r.state === "done" || r.state === "failed" ? r.state : "queued";
  const out: ResumeFile = { v: 1, name: r.name.slice(0, 200), addedAt: r.addedAt, chars: typeof r.chars === "number" ? r.chars : r.text.length, text: r.text.slice(0, RESUME_MAX_CHARS), state };
  const c = r.check;
  if (typeof c === "object" && c !== null && Array.isArray((c as { claims?: unknown }).claims) && typeof (c as { at?: unknown }).at === "string") {
    const claims: ClaimResult[] = [];
    for (const x of (c as { claims: unknown[] }).claims) {
      if (typeof x !== "object" || x === null) continue;
      const y = x as Record<string, unknown>;
      if (typeof y.text !== "string" || (y.verdict !== "supported" && y.verdict !== "partly" && y.verdict !== "not-found")) continue;
      const entries: ClaimEntry[] = [];
      if (Array.isArray(y.entries)) for (const e of y.entries) if (typeof e === "object" && e !== null && typeof (e as ClaimEntry).id === "string" && typeof (e as ClaimEntry).title === "string") entries.push({ id: (e as ClaimEntry).id, title: (e as ClaimEntry).title });
      claims.push({ text: y.text.slice(0, RESUME_CLAIM_MAX_CHARS + 1), verdict: y.verdict, entries: entries.slice(0, 3) });
    }
    out.check = { at: (c as { at: string }).at, claims: claims.slice(0, RESUME_MAX_CLAIMS) };
  }
  return out;
}
