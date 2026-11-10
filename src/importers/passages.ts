/**
 * Split long documents into passages at H2/H3 headings, at most ~maxWords each. Owner: E3.
 * Offsets are character offsets into the original text so passages can be stored as file-range TextRefs
 * (the original is never copied or modified).
 */
import { wordCount } from "../shared/text";

export interface Passage {
  n: number;
  start: number;
  end: number;
  heading?: string;
  words: number;
}

const HEADING = /^(#{2,3})\s+(.+?)\s*#*\s*$/gm;

export function splitPassages(text: string, maxWords = 1200): Passage[] {
  const cuts: { at: number; heading?: string }[] = [{ at: 0 }];
  for (const m of text.matchAll(HEADING)) {
    if (m.index !== undefined && m.index > 0) cuts.push({ at: m.index, heading: m[2] });
  }
  const sections: { start: number; end: number; heading?: string }[] = cuts.map((c, i) => ({
    start: c.at,
    end: i + 1 < cuts.length ? (cuts[i + 1] as { at: number }).at : text.length,
    ...(c.heading !== undefined ? { heading: c.heading } : {}),
  }));
  const out: Passage[] = [];
  for (const s of sections) {
    const body = text.slice(s.start, s.end);
    if (body.trim().length === 0) continue;
    const words = wordCount(body);
    if (words <= maxWords) {
      out.push({ n: out.length, start: s.start, end: s.end, words, ...(s.heading !== undefined ? { heading: s.heading } : {}) });
      continue;
    }
    // Oversized section: split at paragraph breaks, keeping each chunk ≤ maxWords where possible.
    let chunkStart = s.start;
    let chunkWords = 0;
    const paras = body.split(/(\n\s*\n)/);
    let cursor = s.start;
    for (const p of paras) {
      const w = wordCount(p);
      if (chunkWords > 0 && chunkWords + w > maxWords) {
        out.push({ n: out.length, start: chunkStart, end: cursor, words: chunkWords, ...(s.heading !== undefined ? { heading: s.heading } : {}) });
        chunkStart = cursor;
        chunkWords = 0;
      }
      chunkWords += w;
      cursor += p.length;
    }
    if (cursor > chunkStart) out.push({ n: out.length, start: chunkStart, end: cursor, words: chunkWords, ...(s.heading !== undefined ? { heading: s.heading } : {}) });
  }
  return out.map((p, i) => ({ ...p, n: i }));
}

export interface BytePassage extends Passage {
  /** UTF-8 byte range of the passage in the file (what a file TextRef stores). */
  byteStart: number;
  byteEnd: number;
}

/** `splitPassages` with UTF-8 byte offsets (the text must be exactly the decoded file: see decodeExactUtf8). */
export function splitBytePassages(text: string, maxWords = 1200): BytePassage[] {
  const out: BytePassage[] = [];
  let pos = 0;
  let bytes = 0;
  for (const p of splitPassages(text, maxWords)) {
    bytes += Buffer.byteLength(text.slice(pos, p.start), "utf8");
    const byteStart = bytes;
    const len = Buffer.byteLength(text.slice(p.start, p.end), "utf8");
    bytes += len;
    pos = p.end;
    out.push({ ...p, byteStart, byteEnd: byteStart + len });
  }
  return out;
}
