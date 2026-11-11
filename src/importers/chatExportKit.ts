/**
 * Shared kit of the chat, notes and reading export importers (WhatsApp, Telegram, Discord, Slack, Google Keep,
 * Evernote, Roam, Kindle, Zoom). Each format file describes one export (`ChatExportDef`): which member names
 * mean "this is mine", and how to turn the files into conversations or notes. This module does the rest:
 *  - it plugs the format into the shared export pass (zip.ts `runExportImport`: lock, resume cursor, the writer
 *    that screens secrets and keeps ids stable, the manifest), so these exports go through the same screening
 *    as the chat services;
 *  - it reads files from the export through one capped reader that also hashes what it read (the manifest key);
 *  - it supplies the inspector `import.inspect` uses for the Add to your record sheet (counts only, never text).
 * Everything is local: an export is a file the person downloaded; nothing is fetched, and malformed input ends
 * as a fixed warning code, never as a throw past the importer.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ChatExportKey } from "../shared/chatExportKinds";
import { CortexError, isCortexError } from "../shared/errors";
import { conversationId, entryId } from "../shared/ids";
import type { InspectResult, SourceImportStats } from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import type { DateStrength, IsoDate, SourceKind, Speaker } from "../shared/types";
import { sha256Text } from "../node/hash";
import type { DiscoveredUnit, ImportContext, Importer } from "./common";
import {
  checkExportPath,
  discoverExport,
  humanSpeaker,
  loadExportState,
  openExportSource,
  openProblem,
  runExportImport,
  type ExportConversation,
  type ExportFormat,
  type ExportKind,
  type ExportSource,
  type ExportSourceKind,
  type ExportTurn,
  type ExportUnit,
  type IdentifiedExport,
  type LocatedExport,
  type PreparedExport,
} from "./zip";
import type { ExtraInspector } from "./extra/index";

/** The most one file of an export may be when it is read whole. Bigger is refused, not read. */
export const MAX_CHAT_FILE_BYTES = 400 * 1024 * 1024;
/** Documents (notes, highlights) of one project are stored in groups of this many. */
export const NOTES_PER_UNIT = 200;

// ───────────────────────────── what a format supplies ─────────────────────────────

export interface ChatParseEnv {
  settings: CortexSettings;
  /** Speaker of the person's own side (Settings › Privacy › Which speaker is you). */
  human: Speaker;
  signal: AbortSignal;
  /** When the export file was last written: the latest the writing can date from (an upper bound only). */
  exportTime?: IsoDate;
  /** The export's own name (file or folder name, without the extension). */
  exportName: string;
  /** Reads files of the export and hashes what was read. */
  reader: DataReader;
}

export interface ChatExportDef {
  readonly key: ChatExportKey;
  /** What the person calls it ("WhatsApp"). */
  readonly label: string;
  /** From member names alone: is this export of this kind? */
  recognise(names: readonly string[]): boolean;
  /** For names that fit more than one kind (a lone .json): a look at the content. Absent = the names decide. */
  sniff?(src: ExportSource, reader: DataReader): Promise<boolean>;
  /** Every conversation (or group of notes), in a deterministic order. */
  parse(src: ExportSource, env: ChatParseEnv): Promise<ExportConversation[]>;
  /** What the preview counts as "items": conversations (default) or the entries inside. */
  countEntries?: boolean;
}

// ───────────────────────────── reading ─────────────────────────────

/** Reads members of one export, capped, hashing names and bytes in the order read (the manifest key). */
export class DataReader {
  private readonly hash = createHash("sha256");
  bytes = 0;

  constructor(
    readonly src: ExportSource,
    private readonly signal: AbortSignal,
  ) {}

  private check(): void {
    if (this.signal.aborted) throw new CortexError("E_CANCELLED", "cancelled");
  }

  /** The whole member as bytes. Over the cap: E_PARSE (an export file that cannot be read whole). */
  async read(name: string, cap = MAX_CHAT_FILE_BYTES): Promise<Buffer> {
    this.check();
    const chunks: Buffer[] = [];
    let n = 0;
    const stream = await this.src.open(name);
    try {
      for await (const c of stream) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
        n += b.length;
        if (n > cap) throw new CortexError("E_PARSE", "an export file is too large to read");
        chunks.push(b);
      }
    } finally {
      (stream as { destroy?: () => void }).destroy?.();
    }
    const all = Buffer.concat(chunks);
    this.hash.update(`${name}\0${all.length}\0`);
    this.hash.update(all);
    this.bytes += all.length;
    return all;
  }

  /** The member as text (BOM and encoding handled; line ends are "\n"). */
  async text(name: string, cap = MAX_CHAT_FILE_BYTES): Promise<string> {
    return decodeText(await this.read(name, cap));
  }

  /** Parsed JSON of a member; a file that is not JSON is E_PARSE. */
  async json(name: string, cap = MAX_CHAT_FILE_BYTES): Promise<unknown> {
    const text = await this.text(name, cap);
    try {
      return JSON.parse(text);
    } catch {
      throw new CortexError("E_PARSE", "an export file is not valid JSON");
    }
  }

  /** The member in pieces of text, for files too big or too repetitive to hold whole (Evernote). */
  async *chunks(name: string): AsyncGenerator<string> {
    this.check();
    const dec = new StringDecoder("utf8");
    this.hash.update(`${name}\0stream\0`);
    const stream = await this.src.open(name);
    try {
      for await (const c of stream) {
        this.check();
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
        this.hash.update(b);
        this.bytes += b.length;
        const s = dec.write(b);
        if (s.length > 0) yield s;
      }
    } finally {
      (stream as { destroy?: () => void }).destroy?.();
    }
    const rest = dec.end();
    if (rest.length > 0) yield rest;
  }

  /** The first bytes of a member as text, not counted in the hash (recognition only). */
  async head(name: string, bytes = 16 * 1024): Promise<string> {
    const stream = await this.src.open(name);
    const chunks: Buffer[] = [];
    let n = 0;
    try {
      for await (const c of stream) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
        chunks.push(b);
        n += b.length;
        if (n >= bytes) break;
      }
    } finally {
      (stream as { destroy?: () => void }).destroy?.();
    }
    return decodeText(Buffer.concat(chunks).subarray(0, bytes));
  }

  get sha256(): string {
    return this.hash.copy().digest("hex");
  }
}

/** Bytes to text: a UTF-8 or UTF-16 byte-order mark is honoured; "\r\n" and "\r" become "\n". */
export function decodeText(b: Buffer): string {
  let s: string;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) s = b.subarray(2).toString("utf16le");
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) s = Buffer.from(b.subarray(2)).swap16().toString("utf16le");
  else s = b.toString("utf8").replace(/^﻿/, "");
  return s.replace(/\r\n?/g, "\n");
}

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. A stray quote never throws. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      any = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      any = true;
    } else if (ch === "\n") {
      row.push(field);
      if (any || row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      field = "";
      any = false;
    } else {
      field += ch;
      any = true;
    }
  }
  if (any || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ───────────────────────────── small helpers the formats share ─────────────────────────────

export function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : "");

export function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

export function stem(name: string): string {
  const b = baseName(name);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

/** The first 20 hex digits of sha256 of the parts: a stable id fragment that never contains the text. */
export function fingerprint(...parts: readonly (string | number | undefined)[]): string {
  return sha256Text(parts.map((p) => String(p ?? "")).join("\u001f")).slice(0, 20);
}

/** A calendar time read as UTC (an export that names no time zone has only this); undefined for an impossible date. */
export function civilToIso(y: number, mo: number, d: number, hh = 0, mi = 0, ss = 0): IsoDate | undefined {
  if (![y, mo, d, hh, mi, ss].every(Number.isFinite) || y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return undefined;
  const t = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const back = new Date(t);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  return back.toISOString();
}

export function isoFromMs(ms: unknown): IsoDate | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return y >= 1970 && y <= 2200 ? d.toISOString() : undefined;
}

/** Who wrote a line: the person (by name or handle from Settings › You) or someone else, named. */
export function speakerResolver(env: ChatParseEnv, alsoMine: readonly string[] = []): (name: string) => { speaker: Speaker; detail?: string } {
  const norm = (s: string): string => s.normalize("NFKC").trim().replace(/^@/, "").toLowerCase();
  const mine = new Set([...env.settings.you.names, ...env.settings.you.handles, ...alsoMine].map(norm).filter((s) => s.length > 0));
  return (name) => {
    const n = name.trim();
    if (n.length > 0 && mine.has(norm(n))) return { speaker: env.human };
    return { speaker: "other", detail: (n.length > 0 ? n : "Unknown").slice(0, 120) };
  };
}

export interface TurnInput {
  key: string;
  text: string;
  speaker: { speaker: Speaker; detail?: string };
  at?: IsoDate | undefined;
  strength?: DateStrength;
  detail?: string;
  attachments?: { name: string; mime?: string; bytes?: number }[];
  document?: { title: string };
  /** The value hashed as "the unit as read" (never stored). */
  raw?: unknown;
}

export function turnOf(i: TurnInput): ExportTurn {
  const t: ExportTurn = {
    nativeId: i.key,
    key: i.key,
    kind: i.document ? "document" : "message",
    speaker: i.speaker.speaker,
    text: i.text,
    unitSha256: sha256Text(JSON.stringify(i.raw ?? [i.key, i.text])),
  };
  if (i.speaker.detail !== undefined) t.speakerDetail = i.speaker.detail;
  if (i.at !== undefined) {
    t.at = i.at;
    t.atStrength = i.strength ?? "strong";
    if (i.detail !== undefined) t.atDetail = i.detail;
  }
  if (i.document) t.title = i.document.title.slice(0, 200);
  if (i.attachments && i.attachments.length > 0) t.attachments = i.attachments.slice(0, 50).map((a) => ({ name: a.name.slice(0, 200), bytes: a.bytes ?? 0, mime: a.mime ?? "application/octet-stream" }));
  return t;
}

/** Keys that stay the same when an export is made again: the native id, or a fingerprint with a count for exact repeats. */
export class KeyMaker {
  private readonly seen = new Map<string, number>();
  constructor(private readonly prefix: string) {}
  /** The same (time, sender, text) twice in a chat gets `:2`; the first keeps the plain key. */
  next(...parts: readonly (string | number | undefined)[]): string {
    const fp = fingerprint(...parts);
    const n = (this.seen.get(fp) ?? 0) + 1;
    this.seen.set(fp, n);
    return `${this.prefix}:${fp}${n > 1 ? `:${n}` : ""}`;
  }
}

/** A conversation record from its turns (sorted by the caller). Dates are read from the turns that carry one. */
export function conversationOf(nativeId: string, title: string, turns: ExportTurn[], extra: Partial<ExportConversation> = {}): ExportConversation {
  const times = turns.map((t) => (t.at !== undefined && t.atStrength !== "bound" ? Date.parse(t.at) : Number.NaN)).filter((n) => Number.isFinite(n));
  const conv: ExportConversation = { nativeId, title: title.slice(0, 200), turns, ...extra };
  if (times.length > 0) {
    conv.createdAt = new Date(Math.min(...times)).toISOString();
    conv.updatedAt = new Date(Math.max(...times)).toISOString();
  }
  return conv;
}

/** Documents (notes, highlights) as units: one per project, in groups of NOTES_PER_UNIT, in a stable order. */
export function noteUnits(source: ChatExportKey, notes: readonly { project?: string; turn: ExportTurn }[], fallbackTitle: string): ExportConversation[] {
  const byProject = new Map<string, ExportTurn[]>();
  for (const n of notes) {
    const k = n.project ?? "";
    const list = byProject.get(k) ?? [];
    list.push(n.turn);
    byProject.set(k, list);
  }
  const out: ExportConversation[] = [];
  for (const [project, turns] of [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (let i = 0; i < turns.length; i += NOTES_PER_UNIT) {
      const slice = turns.slice(i, i + NOTES_PER_UNIT);
      const part = Math.floor(i / NOTES_PER_UNIT) + 1;
      const conv = conversationOf(`${source}:notes:${fingerprint(project)}:${part}`, project || fallbackTitle, slice, { standalone: true });
      if (project !== "") conv.project = project.slice(0, 120);
      out.push(conv);
    }
  }
  return out;
}

// ───────────────────────────── the export pass ─────────────────────────────

interface ChatPlan {
  conversations: ExportConversation[];
}

const NO_LOCATION = (): LocatedExport => ({ kind: "unknown", conversations: [], takeout: false });

function asSource(key: ChatExportKey): ExportSourceKind {
  return key as unknown as ExportSourceKind;
}

async function exportTimeOf(path_: string): Promise<IsoDate | undefined> {
  try {
    const st = await fsp.stat(path_);
    return new Date(st.mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

function exportNameOf(file: string): string {
  const b = path.basename(file);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

/** Any failure of a parser other than cancellation is "the export is not what it says": a fixed code, no text. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (isCortexError(e)) throw e;
    throw new CortexError("E_PARSE", "the export could not be read");
  }
}

async function parseExport(def: ChatExportDef, src: ExportSource, settings: CortexSettings, signal: AbortSignal): Promise<{ conversations: ExportConversation[]; reader: DataReader }> {
  const reader = new DataReader(src, signal);
  const exportTime = await exportTimeOf(src.path);
  const env: ChatParseEnv = { settings, human: humanSpeaker(settings, def.key as SourceKind), signal, exportName: exportNameOf(src.path), reader };
  if (exportTime !== undefined) env.exportTime = exportTime;
  const conversations = await guarded(() => def.parse(src, env));
  return { conversations: conversations.filter((c) => c.turns.length > 0), reader };
}

async function identify(def: ChatExportDef, src: ExportSource, signal: AbortSignal): Promise<IdentifiedExport> {
  const names = src.members.map((m) => m.name);
  const wrong = (problem: IdentifiedExport["problem"]): IdentifiedExport => ({ kind: "unknown" as ExportKind, loc: NO_LOCATION(), ...(problem ? { problem } : {}) });
  if (!def.recognise(names)) return wrong("export-not-recognised");
  if (def.sniff) {
    const ok = await guarded(() => def.sniff!(src, new DataReader(src, signal))).catch(() => false);
    if (!ok) return wrong("export-not-recognised");
  }
  return { kind: def.key as unknown as ExportKind, loc: NO_LOCATION() };
}

export function formatOf(def: ChatExportDef): ExportFormat<ChatPlan> {
  return {
    source: asSource(def.key),
    label: def.label,
    enabled: (s: CortexSettings) => s.sources.chatExports[def.key].enabled,
    keepCopy: () => false,
    cursorTag: () => "",
    identify: (src, signal) => identify(def, src, signal),
    async prepare(src, _loc, env): Promise<PreparedExport<ChatPlan>> {
      const { conversations, reader } = await parseExport(def, src, env.settings, env.signal);
      return { units: conversations.length, sha256: reader.sha256, bytes: reader.bytes, plan: { conversations } };
    },
    async *units(_src, _loc, prep, _env, from): AsyncGenerator<ExportUnit> {
      for (let i = from; i < prep.plan.conversations.length; i++) yield { index: i, conversation: prep.plan.conversations[i] as ExportConversation };
    },
  };
}

export class ChatExportImporter implements Importer<{ kind: ChatExportKey; file: string }> {
  readonly kind: ChatExportKey;
  readonly source: SourceKind;
  readonly label: string;
  private readonly format: ExportFormat<ChatPlan>;

  constructor(private readonly def: ChatExportDef) {
    this.kind = def.key;
    this.source = def.key as SourceKind;
    this.label = def.label;
    this.format = formatOf(def);
  }

  async discover(sel: { kind: ChatExportKey; file: string }, _ctx: ImportContext): Promise<DiscoveredUnit[]> {
    return discoverExport(sel.file, this.label);
  }

  async run(sel: { kind: ChatExportKey; file: string }, ctx: ImportContext): Promise<SourceImportStats> {
    return runExportImport(ctx, sel.file, this.format);
  }
}

// ───────────────────────────── import.inspect ─────────────────────────────

const asKind = (k: string): InspectResult["kind"] => k as InspectResult["kind"];

function emptyResult(kind: string, problem?: InspectResult["problem"]): InspectResult {
  const out: InspectResult = { kind: asKind(kind), conversations: 0, projects: 0, attachments: 0, alreadyImported: 0 };
  if (problem !== undefined) out.problem = problem;
  return out;
}

/**
 * The preview of a dropped export: how many items, over what dates, how many files named, how many are here
 * already. Counts only; no text leaves the file. A name that fits but content that does not gives null, so the
 * next kind is tried.
 */
export function inspectorOf(def: ChatExportDef): ExtraInspector {
  return {
    kind: def.key,
    recognise: (names) => def.recognise(names),
    async inspect(file, ctx): Promise<InspectResult | null> {
      const blocked = checkExportPath(file, ctx.settings);
      if (blocked) return emptyResult(def.key, blocked);
      let src: ExportSource;
      try {
        src = await openExportSource(file);
      } catch (e) {
        if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
        return emptyResult(def.key, openProblem(e));
      }
      try {
        if (def.sniff) {
          const ok = await guarded(() => def.sniff!(src, new DataReader(src, ctx.token.signal))).catch(() => false);
          if (!ok) return null;
        }
        let parsed: ExportConversation[];
        try {
          parsed = (await parseExport(def, src, ctx.settings, ctx.token.signal)).conversations;
        } catch (e) {
          if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
          return emptyResult(def.key, "export-not-recognised");
        }
        if (parsed.length === 0) return emptyResult(def.key, "export-empty");
        const out = emptyResult(def.key);
        const state = await loadExportState(ctx, def.key as SourceKind);
        let first = Number.POSITIVE_INFINITY;
        let last = Number.NEGATIVE_INFINITY;
        const projects = new Set<string>();
        for (const c of parsed) {
          if (c.project !== undefined) projects.add(c.project);
          if (c.standalone) {
            for (const t of c.turns) if (state.entries.has(entryId(def.key as SourceKind, t.key))) out.alreadyImported++;
          } else if (state.records.has(conversationId(def.key as SourceKind, c.nativeId))) out.alreadyImported++;
          out.conversations += def.countEntries ? c.turns.length : 1;
          for (const t of c.turns) {
            out.attachments += t.attachments?.length ?? 0;
            const ms = t.at !== undefined && t.atStrength !== "bound" ? Date.parse(t.at) : Number.NaN;
            if (Number.isFinite(ms)) {
              first = Math.min(first, ms);
              last = Math.max(last, ms);
            }
          }
        }
        out.projects = projects.size;
        if (Number.isFinite(first) && Number.isFinite(last)) out.range = [new Date(first).toISOString(), new Date(last).toISOString()];
        return out;
      } finally {
        await src.close().catch(() => undefined);
      }
    },
  };
}
