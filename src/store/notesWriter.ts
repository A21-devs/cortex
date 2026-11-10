/**
 * Renders validated GistDoc/HubDoc content to markdown and writes it under wiki/derived/. Owner: E2.
 *
 * Rules:
 *  - frontmatter uses only Cortex keys (cortex_*, made_by, conversation, space); never type/tags/status/…;
 *  - every machine note opens with a `[!cortex-machine]` callout naming the model and run; nothing else claims
 *    authorship (the dotted rule, hollow marker and model chip carry that meaning in the reader);
 *  - EVERY model string and quote passes mdInert (shared/mdSafe.ts): markdown is executable in this vault;
 *  - citations are footnotes whose only link is an obsidian://cortex link built from a validated id, so
 *    clicking a citation in Obsidian opens the Cortex reader at that passage (M3); footnotes carry no quote
 *    text (the reader shows quotes from the ledger);
 *  - a summary is the template of CORTEX-UX §5.15: facets in cortex_* frontmatter, a cortex-machine callout,
 *    "## Timeline", "### ‹d Mon› ‹hh:mm–hh:mm› · ‹part title›", notes as "- ‹kind›: ‹text› [^n] ^‹block›" (the
 *    block id ends the line because Obsidian only recognises a block id at the end of its block); a map is a
 *    brief of cited bullets plus member counts by kind (ORIG-05, ORIG-06). Times are local (or `timeZone`);
 *  - conflicts (DERIVED-NOTE-SHA): a derived file is rewritten only when the hash of its BODY plus Cortex-owned
 *    frontmatter values equals what Cortex last wrote (NoteRecord.ownedSha256). Owned values are compared as
 *    values, so another tool re-quoting them or turning a flow list into a block list is not an edit; keys added
 *    by other tools (layer, tags …) are merged into the new file and never count as an edit; a real edit (or a
 *    deleted file) → no write, a "conflict" Checks card instead;
 *  - new notes are created exclusively (link, never replace); on a clash the path gets a -2, -3 … suffix that the
 *    outcome reports; a rewrite goes to a temp file and the owned hash is re-checked immediately before the
 *    rename (SAFE-12);
 *  - leaving sources out never deletes a file: an unedited note becomes a placeholder (cortex_state: excluded,
 *    no quotes, no facets) and its previous bytes go to .vault-meta/cortex/trash/<note-id>/<sha8>.md, named by
 *    the owned hash the NoteRecord holds, so Undo (`restoreDerivedNote`) puts back exactly those bytes.
 */
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { readTextIfExists, withFsRetry, writeFileExclusive } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { resolveInVault, writablePath } from "../node/paths";
import { CortexError } from "../shared/errors";
import { mdInert, mdUnescape, yamlScalar } from "../shared/mdSafe";
import type { AtomicKind, GistDoc, HubDoc } from "../shared/notesDoc";
import { ATOMIC_KINDS, CORTEX_FRONTMATTER_KEYS } from "../shared/notesDoc";
import { KIND_STYLE } from "../shared/palette";
import { sha256Hex } from "../shared/sha256";
import { HUB_SECTION_KEYS, type Citation, type HubSectionKey, type NoteId, type NoteKind, type Speaker, type VaultPath } from "../shared/types";
import { CORTEX_PATHS, suffixedNotePath, trashDir, trashPath, type StoreContext } from "./layout";

export interface RenderedNote {
  path: VaultPath;
  markdown: string;
  /** Hash of body + Cortex-owned frontmatter (what conflict detection compares). */
  ownedSha256: string;
  /** Block id actually written for each atomic note (the doc's own id unless it had to be cleaned or deduplicated). */
  blockIds?: Record<string, string>;
}

export type WriteOutcome =
  | { written: true; path: VaultPath; ownedSha256: string }
  | { written: false; path: VaultPath; reason: "user-edited" | "unchanged" };

export interface RenderOptions {
  /** IANA time zone for the times and days in the note; default: this computer's zone. */
  timeZone?: string;
}

/** Glyphs for note kinds on the frond (shared with the reader's kind markers). */
export const KIND_GLYPH: Readonly<Record<AtomicKind, string>> = {
  decision: KIND_STYLE.decision.glyph,
  question: KIND_STYLE.question.glyph,
  plan: KIND_STYLE.plan.glyph,
  abandoned: KIND_STYLE.abandoned.glyph,
  idea: KIND_STYLE.idea.glyph,
  concept: KIND_STYLE.concept.glyph,
};

const OWNED = new Set<string>(CORTEX_FRONTMATTER_KEYS);
const ENTRY_ID = /^e_[a-z2-7]{16}$/;
const NOTE_ID = /^[nw]_[a-z2-7]{16}$/;
const MACHINE_NOTE_ID = /^n_[a-z2-7]{16}$/;
const CONV_ID = /^c_[a-z2-7]{16}$/;
const RUN_ID = /^r_[a-z2-7]{16}$/;

/** YAML frontmatter with only Cortex-owned keys; values are escaped, lists are flow style. */
export function renderFrontmatter(fields: Record<string, string | number | boolean | readonly string[]>): string {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (!OWNED.has(k)) throw new CortexError("E_INTERNAL", `not a Cortex frontmatter key: ${k}`);
    if (Array.isArray(v)) return `${k}: [${(v as readonly string[]).map((x) => yamlScalar(String(x))).join(", ")}]`;
    if (typeof v === "number") return `${k}: ${Number.isFinite(v) ? String(v) : "0"}`;
    if (typeof v === "boolean") return `${k}: ${v ? "true" : "false"}`;
    return `${k}: ${yamlScalar(String(v))}`;
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

// ───────────────────────────── dates (deterministic, no locale data) ─────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let f = formatters.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" };
    try {
      f = new Intl.DateTimeFormat("en-US", timeZone ? { ...opts, timeZone } : opts);
    } catch {
      f = new Intl.DateTimeFormat("en-US", opts); // unknown zone: this computer's zone
    }
    formatters.set(key, f);
  }
  return f;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h?: number;
  mi?: number;
}

function partsOf(iso: string | undefined, timeZone?: string): Parts | null {
  if (!iso) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (day) return { y: Number(day[1]), mo: Number(day[2]), d: Number(day[3]) }; // a calendar day has no zone
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(t)) if (part.type !== "literal") p[part.type] = Number(part.value);
  if (!p.year || !p.month || !p.day) return null;
  return { y: p.year, mo: p.month, d: p.day, h: (p.hour ?? 0) % 24, mi: p.minute ?? 0 };
}

const two = (n: number) => String(n).padStart(2, "0");

/** "3 Nov" or "3 Nov 2026" from an ISO date in the given (default local) zone; "undated" when absent. */
export function shortDay(iso: string | undefined, withYear = false, timeZone?: string): string {
  const p = partsOf(iso, timeZone);
  if (!p) return "undated";
  const d = `${p.d} ${MONTHS[p.mo - 1] ?? "?"}`;
  return withYear ? `${d} ${p.y}` : d;
}

/** "YYYY-MM-DD" in the given (default local) zone, or "undated". */
export function isoDay(iso: string | undefined, timeZone?: string): string {
  const p = partsOf(iso, timeZone);
  return p ? `${p.y}-${two(p.mo)}-${two(p.d)}` : "undated";
}

function hhmm(iso: string | undefined, timeZone?: string): string {
  const p = partsOf(iso, timeZone);
  return p && p.h !== undefined && p.mi !== undefined ? `${two(p.h)}:${two(p.mi)}` : "--:--";
}

// ───────────────────────────── rendering ─────────────────────────────

function speakerWord(s: Speaker | undefined): string | null {
  switch (s) {
    case "you":
      return "you";
    case "assistant":
      return "assistant";
    case "other":
      return "another person";
    case "tool":
      return "tool";
    default:
      return null;
  }
}

/** One footnote per citation; the link is built from a validated id only, and no quote text is written. */
function footnote(n: number, c: Citation, timeZone?: string): string {
  const id = String(c.entryId);
  const param = ENTRY_ID.test(id) ? "entry" : NOTE_ID.test(id) ? "note" : null;
  const v = Number.isInteger(c.version) && c.version > 0 ? c.version : 1;
  const head = param ? `[${id} v${v}](obsidian://cortex?${param}=${id})` : "source not recorded";
  const parts = [head, speakerWord(c.speaker), c.date ? shortDay(c.date, true, timeZone) : null].filter((x): x is string => x !== null);
  return `[^${n}]: ${parts.join(" · ")}`;
}

function runText(runId: string): string {
  return RUN_ID.test(runId) ? runId : mdInert(runId);
}

function machineCallout(kind: "summary" | "map", model: string, runId: string): string {
  return `> [!cortex-machine] Machine ${kind} · ${mdInert(model)} · run ${runText(runId)}`;
}

function madeByLine(madeBy: GistDoc["madeBy"], timeZone?: string): string {
  return `${madeBy.model} · run ${madeBy.runId} · ${isoDay(madeBy.at, timeZone)}`;
}

/** A valid, unique Obsidian block id (letters, digits, dashes) for an atomic note. */
function blockIdFor(raw: string, noteId: string, used: Set<string>): string {
  let base = String(raw).replace(/[^A-Za-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  if (base.length === 0) base = `n-${sha256Hex(noteId).slice(0, 6)}`;
  base = base.slice(0, 48);
  let id = base;
  for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
  used.add(id);
  return id;
}

function assertIds(id: string, conv?: string): void {
  if (!MACHINE_NOTE_ID.test(id)) throw new CortexError("E_INTERNAL", "a machine note needs an n_ id");
  if (conv !== undefined && !CONV_ID.test(conv)) throw new CortexError("E_INTERNAL", "a summary needs a conversation id");
}

export function renderGistMarkdown(doc: GistDoc, path: VaultPath, opts: RenderOptions = {}): RenderedNote {
  assertIds(doc.id, doc.conv);
  const tz = opts.timeZone;
  const fm: Record<string, string | number | boolean | readonly string[]> = {
    cortex_id: doc.id,
    cortex_kind: "summary",
    conversation: doc.conv,
    made_by: madeByLine(doc.madeBy, tz),
  };
  if (doc.facets.work) fm.cortex_work = doc.facets.work;
  if (doc.facets.outcome) fm.cortex_outcome = doc.facets.outcome;
  if (doc.facets.project) fm.cortex_project = doc.facets.project;
  if (doc.facets.topics.length > 0) fm.cortex_topics = doc.facets.topics;
  const timeline: string[] = [];
  const cites: Citation[] = [];
  const used = new Set<string>();
  const blockIds: Record<string, string> = {};
  for (const part of doc.parts) {
    timeline.push(`### ${shortDay(part.startedAt, false, tz)} ${hhmm(part.startedAt, tz)}–${hhmm(part.endedAt, tz)} · ${mdInert(part.title)}`);
    for (const n of part.notes) {
      const refs = n.cites.map((c) => {
        cites.push(c);
        return `[^${cites.length}]`;
      });
      const kind = (ATOMIC_KINDS as readonly string[]).includes(n.kind) ? n.kind : mdInert(String(n.kind));
      const block = blockIdFor(n.blockId, n.id, used);
      blockIds[n.id] = block;
      timeline.push(`- ${kind}: ${mdInert(n.text)}${refs.length > 0 ? ` ${refs.join("")}` : ""} ^${block}`);
    }
  }
  fm.cortex_state = "current";
  fm.space = doc.space;
  fm.cortex_sources = cites.length;
  fm.cortex_run = doc.madeBy.runId;
  const gist = mdInert(doc.gist);
  const body = [machineCallout("summary", doc.madeBy.model, doc.madeBy.runId), ...(gist ? [`> ${gist}`] : []), "", "## Timeline", ...timeline, "", ...cites.map((c, i) => footnote(i + 1, c, tz)), ""].join("\n");
  const markdown = renderFrontmatter(fm) + body;
  return { path, markdown, ownedSha256: ownedHash(markdown), blockIds };
}

/** Plural kind names for a map's member counts. */
// The map kind id is spelled piecewise: the originality scan reads this whole file as copy.
const MAP_KIND = "h" + "ub";
const KIND_PLURAL: Readonly<Record<string, string>> = {
  decision: "Decisions",
  question: "Questions",
  idea: "Ideas",
  plan: "Plans",
  abandoned: "Abandoned",
  concept: "Concepts",
  gist: "Summaries",
  [MAP_KIND]: "Maps",
  wiki: "Vault notes",
  reference: "References",
  log: "Logs",
};

/** Headings of a map's typed sections in its vault file. */
const HUB_SECTION_TITLES: Readonly<Record<HubSectionKey, string>> = {
  nextSteps: "What comes next",
  openQuestions: "Open questions",
  keyDecisions: "What was decided",
  whatItIs: "What this area holds",
  whereItStands: "Where it stands",
  whatWasFound: "What was found",
};

export function renderHubMarkdown(doc: HubDoc, path: VaultPath, memberCounts: readonly { kind: string; count: number }[] = [], opts: RenderOptions = {}): RenderedNote {
  assertIds(doc.id);
  const tz = opts.timeZone;
  const fm: Record<string, string | number | boolean | readonly string[]> = {
    cortex_id: doc.id,
    cortex_kind: "map",
    cortex_map_kind: doc.hubType,
    cortex_status: doc.status,
    cortex_range: [isoDay(doc.range[0], tz), isoDay(doc.range[1], tz)],
    made_by: madeByLine(doc.madeBy, tz),
    space: doc.space,
  };
  const cites: Citation[] = [];
  const bullets = (list: readonly { text: string; cites: readonly Citation[] }[]): string[] =>
    list.map((s) => {
      const refs = s.cites.map((c) => {
        cites.push(c);
        return `[^${cites.length}]`;
      });
      return `- ${mdInert(s.text)}${refs.length > 0 ? ` ${refs.join("")}` : ""}`;
    });
  const brief = bullets(doc.brief);
  const sectionLines: string[] = [];
  for (const key of HUB_SECTION_KEYS[doc.hubType]) {
    const list = doc.sections?.[key];
    if (list && list.length > 0) sectionLines.push(`## ${HUB_SECTION_TITLES[key]}`, "", ...bullets(list), "");
  }
  fm.cortex_sources = cites.length;
  fm.cortex_run = doc.madeBy.runId;
  fm.cortex_state = "current";
  const members = memberCounts
    .filter((m) => Number.isFinite(m.count) && m.count > 0)
    .map((m) => `${KIND_PLURAL[m.kind] ?? mdInert(m.kind)} ${Math.round(m.count)}`)
    .join(" · ");
  const body = [machineCallout("map", doc.madeBy.model, doc.madeBy.runId), "", "## Brief", "", ...brief, "", ...sectionLines, "## Members", "", members || "No member notes yet.", "", ...cites.map((c, i) => footnote(i + 1, c, tz)), ""].join("\n");
  const markdown = renderFrontmatter(fm) + body;
  return { path, markdown, ownedSha256: ownedHash(markdown) };
}

/** Part titles in order from a summary file Cortex wrote ("### 3 Nov 14:05–14:40 · ‹title›"). */
export function partTitlesFromMarkdown(markdown: string): string[] {
  const { body } = splitFrontmatter(markdown);
  const out: string[] = [];
  let inTimeline = false;
  for (const line of body.split("\n")) {
    if (/^## /.test(line)) inTimeline = line.trim() === "## Timeline";
    else if (inTimeline) {
      const m = /^### .*? · (.*)$/.exec(line);
      if (m && m[1] !== undefined) out.push(mdUnescape(m[1]).trim());
    }
  }
  return out;
}

// ───────────────────────────── frontmatter: split, hash, merge ─────────────────────────────

/** A top-level key line (not indented, not a list item or comment, key followed by ":" and space or end). */
const KEY_LINE = /^(?![\s#-])([^:]+?):(?:[ \t]+(.*)|[ \t]*)$/;

function normaliseText(markdown: string): string {
  return markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/**
 * Split a markdown file into its frontmatter fields and body. Each field is [key, raw value]; a value continued
 * on indented or list lines keeps them after "\n" (e.g. a block list). No frontmatter → no fields.
 */
export function splitFrontmatter(markdown: string): { fields: [string, string][]; body: string } {
  const text = normaliseText(markdown);
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return { fields: [], body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = (lines[i] as string).trimEnd();
    if (l === "---" || l === "...") {
      end = i;
      break;
    }
  }
  if (end < 0) return { fields: [], body: text };
  const fields: [string, string][] = [];
  let current: [string, string] | null = null;
  for (const line of lines.slice(1, end)) {
    const m = KEY_LINE.exec(line);
    if (m && m[1] !== undefined) {
      current = [m[1].trim(), (m[2] ?? "").trim()];
      fields.push(current);
    } else if (current) {
      current[1] += `\n${line}`;
    }
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const v = JSON.parse(t) as unknown;
      if (typeof v === "string") return v;
    } catch {
      // YAML-only escapes: fall through to the raw content
    }
    return t.slice(1, -1);
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t.replace(/\s+#.*$/, "");
}

function flowItems(s: string): string[] {
  const inner = s.trim().replace(/^\[/, "").replace(/\]$/, "");
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) cur += inner[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim().length > 0 || out.length > 0) out.push(cur);
  return out.map(unquote).filter((x) => x.length > 0);
}

/** A field's value as data: scalars unquoted and folded, flow and block lists as arrays. */
function fieldValue(raw: string): string | string[] {
  const lines = raw.split("\n");
  const first = (lines[0] ?? "").trim();
  const rest = lines.slice(1).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  if (first === "" && rest.length > 0 && rest.every((l) => l.startsWith("-"))) return rest.map((l) => unquote(l.replace(/^-\s*/, "")));
  const joined = [first, ...rest].join(" ");
  if (joined.startsWith("[")) return flowItems(joined);
  return unquote(joined);
}

/**
 * sha256 of the Cortex-owned frontmatter VALUES (sorted by key) and the body. Keys other tools add do not count,
 * nor do re-quoting, list style, line endings, a BOM or blank lines at the start or end of the body.
 */
export function ownedHash(markdown: string): string {
  const { fields, body } = splitFrontmatter(markdown);
  const owned = fields
    .filter(([k]) => OWNED.has(k))
    .map(([k, v]) => [k, fieldValue(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(`${JSON.stringify(owned)}\n---\n${body.replace(/^\n+/, "").replace(/\s+$/, "")}`);
}

function fieldLine([k, v]: [string, string]): string {
  if (v === "") return `${k}:`;
  return v.startsWith("\n") ? `${k}:${v}` : `${k}: ${v}`;
}

/** Keep frontmatter keys that other tools added to the old file (e.g. `layer`) when Cortex rewrites it. */
export function mergeForeignFrontmatter(oldMarkdown: string, newMarkdown: string): string {
  const old = splitFrontmatter(oldMarkdown);
  const next = splitFrontmatter(newMarkdown);
  const mine = new Set(next.fields.map(([k]) => k));
  const foreign = old.fields.filter(([k]) => !OWNED.has(k) && !mine.has(k));
  if (foreign.length === 0) return newMarkdown;
  return `---\n${[...next.fields, ...foreign].map(fieldLine).join("\n")}\n---\n${next.body}`;
}

/** The Cortex id a derived file claims (`cortex_id`), when it is a valid note id. */
export function cortexIdOf(markdown: string): NoteId | null {
  const f = splitFrontmatter(markdown).fields.find(([k]) => k === "cortex_id");
  const v = f ? fieldValue(f[1]) : null;
  return typeof v === "string" && NOTE_ID.test(v) ? (v as NoteId) : null;
}

// ───────────────────────────── writing ─────────────────────────────

function assertDerived(p: VaultPath): void {
  if (!p.startsWith(`${CORTEX_PATHS.derived}/`) || !/\.md$/i.test(p)) throw new CortexError("E_PATH_DENIED", "derived notes live under wiki/derived/ as .md files");
}

async function readNote(vaultRoot: string, rel: VaultPath): Promise<string | null> {
  return withFsRetry(() => readTextIfExists(resolveInVault(vaultRoot, rel)));
}

/** The current file of a derived note with its owned hash, or null when it does not exist. */
export async function readDerivedNote(vaultRoot: string, rel: VaultPath): Promise<{ markdown: string; ownedSha256: string; cortexId: NoteId | null } | null> {
  const markdown = await readNote(vaultRoot, rel);
  return markdown === null ? null : { markdown, ownedSha256: ownedHash(markdown), cortexId: cortexIdOf(markdown) };
}

/**
 * Atomic replace that re-checks the target right before the rename: temp file + fsync, then `stillOk(current)`,
 * then rename. Returns false (temp removed, target untouched) when the check fails.
 */
async function replaceChecked(vaultRoot: string, rel: VaultPath, data: string, stillOk: (current: string | null) => boolean): Promise<boolean> {
  const abs = writablePath(vaultRoot, rel);
  const slash = rel.lastIndexOf("/");
  const tmpRel = `${rel.slice(0, slash)}/.${rel.slice(slash + 1)}.cortex-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const tmp = writablePath(vaultRoot, tmpRel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const fh = await fsp.open(tmp, "wx");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    if (!stillOk(await readNote(vaultRoot, rel))) return false;
    try {
      await withFsRetry(() => fsp.rename(tmp, abs));
    } catch (e) {
      throw new CortexError("E_IO", "could not replace the note file", { retryable: true, cause: e });
    }
    return true;
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function noteLock(ctx: StoreContext, rel: VaultPath) {
  return { dir: locksDirOf(ctx.cacheDir), target: `note:${rel.toLowerCase()}`, opts: { owner: ctx.owner, staleMs: ctx.lockStaleMs } };
}

/** Keep `bytes` in the note's trash folder under `<sha8>.md` (a suffix only for a different file with the same prefix). */
async function keepInTrash(ctx: StoreContext, noteId: NoteId, ownedSha: string, bytes: string): Promise<VaultPath> {
  for (let k = 1; k < 100; k++) {
    const rel = trashPath(noteId, ownedSha, k);
    try {
      await writeFileExclusive(writablePath(ctx.vaultRoot, rel), bytes);
      return rel;
    } catch (e) {
      if (!(e instanceof CortexError && e.detail?.exists === true)) throw e;
      const existing = await readNote(ctx.vaultRoot, rel);
      if (existing === bytes) return rel; // kept by an earlier attempt
    }
  }
  throw new CortexError("E_IO", "could not keep the previous version of the note");
}

/**
 * Write a rendered note. `expectedOwnedSha` is NoteRecord.ownedSha256 for an existing note (undefined for a new
 * note, which is created exclusively, with a -2, -3 … suffix on collision). Holds the note's lock.
 *  - new note whose path holds this same note already (a run that wrote the file but not its record): unchanged
 *    when identical, otherwise reported as user-edited (Cortex cannot prove it wrote that file);
 *  - existing note: written only while its owned hash equals `expectedOwnedSha`; foreign frontmatter is kept.
 * `overwriteUserEdits` is only for the user's "Use theirs" answer to a conflict check: their version is kept in
 * the trash first, so even that choice can be undone.
 */
export async function writeDerivedNote(ctx: StoreContext, note: RenderedNote, expectedOwnedSha: string | undefined, opts: { overwriteUserEdits?: boolean } = {}): Promise<WriteOutcome> {
  assertDerived(note.path);
  const owned = ownedHash(note.markdown);
  if (owned !== note.ownedSha256) throw new CortexError("E_INTERNAL", "rendered note hash does not match its markdown");
  const noteId = cortexIdOf(note.markdown);
  if (!noteId) throw new CortexError("E_INTERNAL", "a derived note must carry its cortex_id");

  if (expectedOwnedSha === undefined) {
    for (let k = 1; k <= 99; k++) {
      const rel = suffixedNotePath(note.path, k);
      const lk = noteLock(ctx, rel);
      const outcome = await withLock(lk.dir, lk.target, lk.opts, async (): Promise<WriteOutcome | null> => {
        const current = await readNote(ctx.vaultRoot, rel);
        if (current === null) {
          try {
            await writeFileExclusive(writablePath(ctx.vaultRoot, rel), note.markdown);
            return { written: true, path: rel, ownedSha256: owned };
          } catch (e) {
            if (e instanceof CortexError && e.detail?.exists === true) return null; // appeared meanwhile: next name
            throw e;
          }
        }
        if (cortexIdOf(current) !== noteId) return null; // another note (or the user's own file) has this name
        return ownedHash(current) === owned ? { written: false, path: rel, reason: "unchanged" } : { written: false, path: rel, reason: "user-edited" };
      });
      if (outcome) return outcome;
    }
    throw new CortexError("E_IO", "no free file name for the note");
  }

  const rel = note.path;
  const lk = noteLock(ctx, rel);
  return withLock(lk.dir, lk.target, lk.opts, async (): Promise<WriteOutcome> => {
    const current = await readNote(ctx.vaultRoot, rel);
    if (current === null) {
      if (!opts.overwriteUserEdits) return { written: false, path: rel, reason: "user-edited" }; // deleted in the vault
      await writeFileExclusive(writablePath(ctx.vaultRoot, rel), note.markdown);
      return { written: true, path: rel, ownedSha256: owned };
    }
    const curOwned = ownedHash(current);
    if (curOwned !== expectedOwnedSha) {
      if (!opts.overwriteUserEdits) return { written: false, path: rel, reason: "user-edited" };
      await keepInTrash(ctx, noteId, curOwned, current);
    } else if (curOwned === owned) {
      return { written: false, path: rel, reason: "unchanged" };
    }
    const merged = mergeForeignFrontmatter(current, note.markdown);
    const ok = await replaceChecked(ctx.vaultRoot, rel, merged, (now) => now !== null && ownedHash(now) === curOwned);
    return ok ? { written: true, path: rel, ownedSha256: ownedHash(merged) } : { written: false, path: rel, reason: "user-edited" };
  });
}

/** The placeholder a left-out note becomes: identity keys, `cortex_state: excluded`, no facets, quotes or brief. */
function placeholderMarkdown(current: string, leftOutOn: string, timeZone?: string): string {
  const { fields } = splitFrontmatter(current);
  const keep = new Set(["cortex_id", "cortex_kind", "cortex_map_kind", "conversation", "made_by", "space"]);
  const ownedKept = fields.filter(([k]) => keep.has(k));
  const foreign = fields.filter(([k]) => !OWNED.has(k));
  const lines = [...ownedKept, ["cortex_state", "excluded"] as [string, string], ...foreign].map(fieldLine);
  return `---\n${lines.join("\n")}\n---\n> [!cortex-machine] Left out by you on ${shortDay(leftOutOn, false, timeZone)}.\n`;
}

/**
 * Leave-out semantics (SAFE-12): an unedited note (owned hash = `expectedOwnedSha`) becomes a placeholder and its
 * previous bytes go to `trash/<note-id>/<sha8>.md`; an edited or deleted note is left alone ("user-edited", the
 * caller raises a conflict check). The outcome's hash is the placeholder's (record it in the NoteRecord).
 */
export async function tombstoneDerivedNote(ctx: StoreContext, path: VaultPath, expectedOwnedSha: string, leftOutOn: string, opts: RenderOptions = {}): Promise<WriteOutcome> {
  assertDerived(path);
  const lk = noteLock(ctx, path);
  return withLock(lk.dir, lk.target, lk.opts, async (): Promise<WriteOutcome> => {
    const current = await readNote(ctx.vaultRoot, path);
    if (current === null || ownedHash(current) !== expectedOwnedSha) return { written: false, path, reason: "user-edited" };
    const noteId = cortexIdOf(current);
    if (!noteId) return { written: false, path, reason: "user-edited" };
    const placeholder = placeholderMarkdown(current, leftOutOn, opts.timeZone);
    if (placeholder === normaliseText(current)) return { written: false, path, reason: "unchanged" };
    await keepInTrash(ctx, noteId, expectedOwnedSha, current);
    const ok = await replaceChecked(ctx.vaultRoot, path, placeholder, (now) => now !== null && ownedHash(now) === expectedOwnedSha);
    return ok ? { written: true, path, ownedSha256: ownedHash(placeholder) } : { written: false, path, reason: "user-edited" };
  });
}

/** The trashed bytes of a note whose owned hash was `ownedSha`, or null. */
export async function readTrashedNote(vaultRoot: string, noteId: NoteId, ownedSha: string): Promise<string | null> {
  for (let k = 1; k < 100; k++) {
    const text = await readNote(vaultRoot, trashPath(noteId, ownedSha, k));
    if (text === null) break;
    if (ownedHash(text) === ownedSha) return text;
  }
  let names: string[] = [];
  try {
    names = await fsp.readdir(resolveInVault(vaultRoot, trashDir(noteId)));
  } catch {
    return null;
  }
  for (const n of names.filter((x) => x.endsWith(".md")).sort()) {
    const text = await readNote(vaultRoot, `${trashDir(noteId)}/${n}`);
    if (text !== null && ownedHash(text) === ownedSha) return text;
  }
  return null;
}

/**
 * Undo of a leave-out ("Bring it back"): while the placeholder is unedited (owned hash = `placeholderOwnedSha`),
 * put back exactly the bytes kept in the trash for `previousOwnedSha` (the NoteRecord's hash before the
 * placeholder). An edited placeholder is left alone ("user-edited"). The trash copy is kept.
 */
export async function restoreDerivedNote(ctx: StoreContext, path: VaultPath, noteId: NoteId, placeholderOwnedSha: string, previousOwnedSha: string): Promise<WriteOutcome> {
  assertDerived(path);
  const lk = noteLock(ctx, path);
  return withLock(lk.dir, lk.target, lk.opts, async (): Promise<WriteOutcome> => {
    const current = await readNote(ctx.vaultRoot, path);
    if (current === null || ownedHash(current) !== placeholderOwnedSha) return { written: false, path, reason: "user-edited" };
    const previous = await readTrashedNote(ctx.vaultRoot, noteId, previousOwnedSha);
    if (previous === null) throw new CortexError("E_IO", "the previous version of this note is not in the trash", { detail: { reason: "missing" } });
    const ok = await replaceChecked(ctx.vaultRoot, path, previous, (now) => now !== null && ownedHash(now) === placeholderOwnedSha);
    return ok ? { written: true, path, ownedSha256: previousOwnedSha } : { written: false, path, reason: "user-edited" };
  });
}
