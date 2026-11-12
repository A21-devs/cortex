/**
 * The text of a document the person hands Cortex as their resume: .txt and .md as they are, .docx (the words of
 * word/document.xml, read from the zip in memory, nothing inside it is run) and .pdf (the text operators of its
 * deflated or plain content streams). Best effort: a scanned or font-encoded PDF yields nothing and the caller
 * says so. Nothing is written and nothing leaves the computer.
 */
import { inflateRawSync, inflateSync } from "node:zlib";
import { CortexError } from "../shared/errors";
import { RESUME_MAX_BYTES, RESUME_MAX_CHARS, type ResumeExtension } from "../shared/resume";

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** word/document.xml from a docx held in memory (stored or deflated member; no zip64, no encryption). */
function docxXml(buf: Buffer): string {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      e = i;
      break;
    }
  }
  if (e < 0) return "";
  let p = buf.readUInt32LE(e + 16);
  for (let n = buf.readUInt16LE(e + 10); n > 0 && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (buf.toString("utf8", p + 46, p + 46 + nameLen) === "word/document.xml" && (buf.readUInt16LE(p + 8) & 1) === 0) {
      const at = buf.readUInt32LE(p + 42);
      const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
      const body = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(body, { maxOutputLength: 32 * 1024 * 1024 }) : body).toString("utf8");
    }
    p = next;
  }
  return "";
}

export function docxPlainText(buf: Buffer): string {
  return docxXml(buf)
    .replace(/<\/w:p>|<w:br\s*\/>|<w:tab\s*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g: string) => {
      if (g[0] === "#") {
        const c = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : "";
      }
      return XML_ENTITIES[g.toLowerCase()] ?? m;
    });
}

function pdfString(s: string): string {
  return s.replace(/\\(\d{1,3}|[\s\S])/g, (_m, g: string) => {
    if (/^\d/.test(g)) return String.fromCharCode(parseInt(g, 8) & 255);
    return g === "n" || g === "r" ? "\n" : g === "t" ? " " : g;
  });
}

/** The text operators of a content stream: TJ arrays, Tj strings, and the moves that start a new line (Td/TD with a vertical step, T*, Tm). */
const PDF_OPS = /\[((?:\\[\s\S]|[^\]\\])*)\]\s*TJ|\(((?:\\[\s\S]|[^)\\])*)\)\s*(?:Tj|'|")|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|T\*|Tm/g;
const PDF_ARRAY = /\(((?:\\[\s\S]|[^)\\])*)\)|(-?\d+(?:\.\d+)?)/g;

export function pdfPlainText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/<<([^>]*)>>\s*stream\r?\n/g)) {
    const from = (m.index ?? 0) + m[0].length;
    const to = raw.indexOf("endstream", from);
    if (to < 0) continue;
    let body: string;
    try {
      const bytes = buf.subarray(from, to);
      body = /FlateDecode/.test(m[1] ?? "") ? inflateSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString("latin1") : bytes.toString("latin1");
    } catch {
      continue;
    }
    for (const bt of body.matchAll(/BT([\s\S]*?)ET/g)) {
      let text = "";
      // Strings are the words; a vertical move (Td/TD with y, T*, Tm) starts a new line.
      for (const t of (bt[1] ?? "").matchAll(PDF_OPS)) {
        if (t[1] !== undefined) text += [...t[1].matchAll(PDF_ARRAY)].map((x) => (x[1] !== undefined ? pdfString(x[1]) : Number(x[2]) < -200 ? " " : "")).join("");
        else if (t[2] !== undefined) text += pdfString(t[2]);
        else if (t[4] === undefined || Number(t[4]) !== 0) text += "\n";
      }
      if (text.trim()) out.push(text);
    }
  }
  const joined = out.join("\n");
  // Fonts that map glyph numbers instead of letters come out as control characters: not readable.
  const letters = (joined.match(/\p{L}/gu) ?? []).length;
  return letters >= 20 && letters / Math.max(1, joined.replace(/\s/g, "").length) > 0.5 ? joined : "";
}

/** The text of a resume file's bytes, tidied and capped; throws E_BAD_REQUEST when nothing readable is in it. */
export function resumeText(buf: Buffer, ext: ResumeExtension): string {
  if (buf.length === 0 || buf.length > RESUME_MAX_BYTES) throw new CortexError("E_BAD_REQUEST", "this file is empty or too large for a resume");
  const raw = ext === "docx" ? docxPlainText(buf) : ext === "pdf" ? pdfPlainText(buf) : buf.toString("utf8");
  const text = raw
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, RESUME_MAX_CHARS);
  if (text.length < 20) throw new CortexError("E_BAD_REQUEST", "no readable text in this file");
  return text;
}
