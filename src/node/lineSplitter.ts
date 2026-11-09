/**
 * Byte-level JSONL splitter for multi-GB transcripts (SPLITLINES-BYTES). Owner: E1.
 *  - searches for 0x0A only in each NEW chunk (the carry is a list of chunks, never re-scanned), so a long line
 *    arriving in 64 KB chunks costs linear time;
 *  - reports each complete line as raw bytes with its absolute byte offsets [start, end) (end is after "\n"), so
 *    the importer's cursor always lands on a line start regardless of CRLF or blank lines;
 *  - an optional `maxLineBytes` drops (and counts) lines that would otherwise grow without bound, keeping the
 *    offsets exact, so one runaway tool output cannot exhaust memory;
 *  - `finish()` reports a final line without "\n" for files known to be complete (exports); live transcripts
 *    never call it, because their last line may still be being written;
 *  - `peekType()` reads the "type" field from the first bytes of a line, so housekeeping lines (api-request-blob,
 *    queue-operation …) are skipped without JSON.parse.
 * shared/jsonl.ts splitLines stays for small in-memory text only.
 */

export interface ByteLine {
  /**
   * Line bytes without the trailing "\n" (a trailing "\r" is kept; trim with trimCr). May be a view into the
   * pushed chunk: valid only during the callback, copy it to keep it.
   */
  bytes: Uint8Array;
  /** Absolute offset of the first byte. */
  start: number;
  /** Absolute offset just after the "\n" (for a line from finish(): just after its last byte). */
  end: number;
}

export interface ByteLineSplitterOptions {
  /** Lines longer than this are skipped (not reported) and counted in `oversize`. Default: no limit. */
  maxLineBytes?: number;
}

export class ByteLineSplitter {
  private carry: Uint8Array[] = [];
  private carryLen = 0;
  private lineStart: number;
  /** True while the current line has already exceeded maxLineBytes (its bytes are being discarded). */
  private dropping = false;
  private readonly maxLineBytes: number;
  /** Lines skipped because they were longer than maxLineBytes. */
  oversize = 0;

  /** `startOffset` = absolute byte offset of the first byte that will be pushed (the cursor). */
  constructor(startOffset = 0, opts: ByteLineSplitterOptions = {}) {
    if (!Number.isFinite(startOffset) || startOffset < 0) throw new RangeError("startOffset must be a non-negative number");
    this.lineStart = startOffset;
    this.maxLineBytes = opts.maxLineBytes !== undefined && opts.maxLineBytes > 0 ? opts.maxLineBytes : Number.POSITIVE_INFINITY;
  }

  /** Offset after the last complete line (where the next pass should resume). */
  get consumed(): number {
    return this.lineStart;
  }

  /** Bytes of an incomplete trailing line held back (a live file ends mid-line). */
  get pending(): number {
    return this.carryLen;
  }

  push(chunk: Uint8Array, onLine: (line: ByteLine) => void): void {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, from);
      if (nl < 0) break;
      const piece = chunk.subarray(from, nl);
      const start = this.lineStart;
      const len = this.carryLen + piece.length;
      const end = start + len + 1;
      this.lineStart = end;
      from = nl + 1;
      if (this.dropping || len > this.maxLineBytes) {
        this.oversize++;
        this.dropping = false;
        this.carry = [];
        this.carryLen = 0;
        continue;
      }
      let bytes: Uint8Array;
      if (this.carryLen === 0) bytes = piece;
      else {
        bytes = new Uint8Array(len);
        let o = 0;
        for (const c of this.carry) {
          bytes.set(c, o);
          o += c.length;
        }
        bytes.set(piece, o);
        this.carry = [];
        this.carryLen = 0;
      }
      onLine({ bytes, start, end });
    }
    if (from < chunk.length) {
      const restLen = chunk.length - from;
      if (this.dropping) {
        this.carryLen += restLen;
      } else if (this.carryLen + restLen > this.maxLineBytes) {
        // Start discarding: keep counting the length so offsets stay exact, but hold no bytes.
        this.dropping = true;
        this.carry = [];
        this.carryLen += restLen;
      } else {
        // Copy (Buffer#slice is a view): the caller may reuse its chunk buffer.
        const rest = new Uint8Array(chunk.subarray(from));
        this.carry.push(rest);
        this.carryLen += restLen;
      }
    }
  }

  /**
   * End of a COMPLETE file: report the held-back final line (no trailing "\n") and return true, or return false
   * when nothing was pending. Never call this for a file that may still grow.
   */
  finish(onLine: (line: ByteLine) => void): boolean {
    if (this.carryLen === 0) return false;
    const start = this.lineStart;
    const end = start + this.carryLen;
    this.lineStart = end;
    if (this.dropping) {
      this.oversize++;
      this.dropping = false;
      this.carry = [];
      this.carryLen = 0;
      return false;
    }
    const bytes = new Uint8Array(this.carryLen);
    let o = 0;
    for (const c of this.carry) {
      bytes.set(c, o);
      o += c.length;
    }
    this.carry = [];
    this.carryLen = 0;
    onLine({ bytes, start, end });
    return true;
  }
}

/** Drop a trailing "\r" (CRLF files). */
export function trimCr(bytes: Uint8Array): Uint8Array {
  return bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.subarray(0, bytes.length - 1) : bytes;
}

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/** Decode a line as UTF-8 (CR trimmed; invalid sequences become U+FFFD). */
export function decodeLine(bytes: Uint8Array): string {
  return decoder.decode(trimCr(bytes));
}

const TYPE_KEY = new TextEncoder().encode('"type"');

function isJsonSpace(b: number | undefined): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;
}

/**
 * The value of the first `"type": "…"` within the first `maxScan` bytes, or undefined. A hint only: the first
 * "type" key may belong to a nested object in unusual writers; Claude Code writes the top-level key first.
 */
export function peekType(bytes: Uint8Array, maxScan = 512): string | undefined {
  const lim = Math.min(bytes.length, maxScan);
  outer: for (let i = 0; i + TYPE_KEY.length < lim; i++) {
    for (let j = 0; j < TYPE_KEY.length; j++) if (bytes[i + j] !== TYPE_KEY[j]) continue outer;
    let k = i + TYPE_KEY.length;
    while (k < lim && isJsonSpace(bytes[k])) k++;
    if (bytes[k] !== 0x3a) continue; // ":" — this "type" was a value, not a key
    k++;
    while (k < lim && isJsonSpace(bytes[k])) k++;
    if (bytes[k] !== 0x22) return undefined; // the value is not a string
    const s = k + 1;
    let e = s;
    while (e < lim && bytes[e] !== 0x22) {
      if (bytes[e] === 0x5c) return undefined; // escaped characters: let the caller parse properly
      e++;
    }
    if (e >= lim) return undefined;
    return decoder.decode(bytes.subarray(s, e));
  }
  return undefined;
}
