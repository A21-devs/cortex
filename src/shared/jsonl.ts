/**
 * JSON Lines helpers shared by ledgers, segments and the runner protocol. Owner: E1.
 * Readers tolerate an incomplete trailing line (a writer may be mid-append, or OneDrive may sync a file while
 * it grows): the remainder is returned as `carry` and never parsed. A UTF-8 byte-order mark at the start of a
 * text is ignored, and CRLF line ends are accepted. For multi-GB files use node/lineSplitter.ts (byte offsets).
 */

export interface SplitResult {
  /** Complete, non-blank lines without their line ends. */
  lines: string[];
  /** Text after the last "\n" (an incomplete line, possibly empty). */
  carry: string;
}

const BOM = "﻿";

function stripBom(s: string): string {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

/** Split `carry + chunk` into complete lines; the text after the last "\n" is returned as carry. */
export function splitLines(chunk: string, carry = ""): SplitResult {
  const text = carry.length === 0 ? stripBom(chunk) : carry + chunk;
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  const lines: string[] = [];
  for (const p of parts) {
    const line = p.endsWith("\r") ? p.slice(0, -1) : p;
    if (line.trim().length > 0) lines.push(line);
  }
  return { lines, carry: rest };
}

export interface ParsedLines<T> {
  records: T[];
  /** 1-based physical line numbers that failed to parse. */
  bad: number[];
  /** Incomplete trailing text that was not parsed. */
  carry: string;
}

/** Parse one line; undefined when it is not valid JSON. */
export function parseJsonLine<T = unknown>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

/**
 * Parse a whole JSONL text. Invalid lines are reported by their physical (1-based) line number, not thrown;
 * blank lines are skipped. A final line without "\n" is treated as incomplete and returned as `carry`.
 */
export function parseJsonl<T = unknown>(text: string): ParsedLines<T> {
  const body = stripBom(text);
  const parts = body.split("\n");
  const carry = parts.pop() ?? "";
  const records: T[] = [];
  const bad: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i] as string;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      bad.push(i + 1);
    }
  }
  return { records, bad, carry };
}

/** Serialise one record as a single JSON line (no trailing newline); throws for values JSON cannot represent. */
export function toJsonLine(record: unknown): string {
  const s = JSON.stringify(record);
  if (typeof s !== "string") throw new TypeError(`cannot serialise ${typeof record} as a JSON line`);
  return s;
}

/** Serialise records as JSONL with a trailing newline (one write = whole lines only). */
export function toJsonl(records: readonly unknown[]): string {
  if (records.length === 0) return "";
  let out = "";
  for (const r of records) out += `${toJsonLine(r)}\n`;
  return out;
}

/** Upsert semantics for ledgers whose records carry `id` + `seq`: keep the highest seq per id (later wins ties). */
export function latestById<T extends { id: string; seq: number }>(records: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of records) {
    const prev = out.get(r.id);
    if (!prev || r.seq >= prev.seq) out.set(r.id, r);
  }
  return out;
}
