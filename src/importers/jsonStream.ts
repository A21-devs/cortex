/**
 * Streaming reader for the top-level JSON array of an export (ChatGPT and Claude.ai `conversations.json`,
 * Claude.ai `projects.json`, Gemini `MyActivity.json`). Owner: E4.
 *
 * A byte-level state machine (depth, in-string, escape) finds each element's extent; only that slice is decoded
 * and JSON.parse()d, so memory is bounded by the largest single element (default cap 256 MB), never by the file.
 * Inside strings the scanner jumps with Buffer#indexOf to the next quote and decides by backslash parity whether
 * it is escaped, so the text bulk of a multi-GB export costs little more than reading it.
 *
 * Tolerated format drift: a UTF-8 byte order mark; an object wrapper whose first array-valued property holds the
 * elements (`{"conversations": [ … ]}`); and, when `onSkip` is given, elements that are too large or are not
 * valid JSON, which are reported and skipped instead of ending the stream. A truncated file yields every complete
 * element and then fails. Errors never quote the input (SAFE-17).
 */
import type { Readable } from "node:stream";
import { CortexError } from "../shared/errors";

export const DEFAULT_MAX_ELEMENT_BYTES = 256 * 1024 * 1024;

export interface JsonArrayStreamOptions {
  /** Abort (or, with `onSkip`, skip) when one element exceeds this many bytes (default 256 MB). */
  maxElementBytes?: number;
  signal?: AbortSignal;
  /** Elements before this index are scanned but neither kept nor parsed (resuming a paused import). */
  skip?: number;
  /** Every raw chunk, in order, before it is scanned (hashing the member while it streams). */
  onChunk?: (chunk: Uint8Array) => void;
  /** Report-and-skip instead of throwing for oversized or invalid elements. */
  onSkip?: (info: SkippedElement) => void;
}

export interface SkippedElement {
  index: number;
  /** Byte offset of the element's first byte in the input. */
  offset: number;
  bytes: number;
  reason: "too-large" | "invalid-json";
}

/** One parsed element with its position in the input (resume cursors, `SourceRef.byteOffset`). */
export interface JsonArrayElement<T> {
  value: T;
  index: number;
  offset: number;
  bytes: number;
}

export interface JsonArrayScan {
  /** Elements in the array. */
  count: number;
  /** Bytes read from the input (the whole input, so a hash taken in `onChunk` covers every byte). */
  bytes: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

function parseError(message: string): CortexError {
  return new CortexError("E_PARSE", message);
}

interface Completed {
  index: number;
  offset: number;
  bytes: number;
  /** Undefined when the element was not kept (skipped or too large). */
  data?: Buffer;
  tooLarge: boolean;
}

type Mode = "start" | "wrapper" | "array" | "done";

/**
 * The scanner: feed chunks in order, collect completed elements. Pure byte logic, no I/O; exported for tests.
 */
export class JsonArrayScanner {
  private mode: Mode = "start";
  private pos = 0;
  private inString = false;
  private escape = false;
  private depth = 0;
  private inPrimitive = false;
  // wrapper mode (top-level object): nesting depth inside the object and whether a value follows a colon
  private wDepth = 0;
  private wAfterColon = false;
  // the element being read
  private index = 0;
  private elemStart = -1;
  private elemKeep = false;
  private elemTooLarge = false;
  private parts: Buffer[] = [];
  private partsLen = 0;

  constructor(
    private readonly skip: number,
    private readonly maxBytes: number,
  ) {}

  /** Elements completed so far (the next element's index). */
  get count(): number {
    return this.index;
  }

  get finished(): boolean {
    return this.mode === "done";
  }

  /** Feed the next chunk; completed elements are appended to `out`. */
  push(buf: Buffer, out: Completed[]): void {
    const base = this.pos;
    let i = 0;
    const n = buf.length;
    while (i < n && this.mode !== "done") {
      if (this.mode === "start") i = this.scanStart(buf, base, i);
      else if (this.mode === "wrapper") i = this.scanWrapper(buf, i);
      else i = this.scanArray(buf, base, i, out);
    }
    if (this.elemStart >= 0 && this.elemKeep) {
      // The element continues in the next chunk: keep what this chunk holds of it.
      const from = Math.max(0, this.elemStart - base);
      const piece = buf.subarray(from);
      this.parts.push(piece);
      this.partsLen += piece.length;
      if (this.partsLen > this.maxBytes) this.dropOversized();
    }
    this.pos = base + n;
  }

  /** Call when the input has ended; throws when the array was not closed. */
  end(): void {
    if (this.mode === "done") return;
    if (this.mode === "start") throw parseError("the export file is empty");
    throw parseError("the export file ended before its list was complete");
  }

  private dropOversized(): void {
    this.elemKeep = false;
    this.elemTooLarge = true;
    this.parts = [];
    this.partsLen = 0;
  }

  private scanStart(buf: Buffer, base: number, i: number): number {
    const n = buf.length;
    for (; i < n; i++) {
      const b = buf[i]!;
      // A UTF-8 byte order mark (EF BB BF) may open the input, possibly split across tiny chunks.
      const bom = base + i < 3 && b === [0xef, 0xbb, 0xbf][base + i];
      if (!bom && !isWs(b)) break;
    }
    if (i >= n) return n;
    const c = buf[i]!;
    if (c === LBRACKET) {
      this.mode = "array";
      return i + 1;
    }
    if (c === LBRACE) {
      this.mode = "wrapper";
      this.wDepth = 1;
      this.wAfterColon = false;
      return i + 1;
    }
    throw parseError("the export file does not hold a JSON list");
  }

  /** Inside a top-level object: find the first property whose value is an array. */
  private scanWrapper(buf: Buffer, i: number): number {
    const n = buf.length;
    while (i < n) {
      if (this.inString) {
        i = this.skipString(buf, i);
        continue;
      }
      const c = buf[i]!;
      if (isWs(c)) {
        i++;
        continue;
      }
      if (c === QUOTE) {
        this.inString = true;
        if (this.wDepth === 1) this.wAfterColon = false;
        i++;
        continue;
      }
      if (this.wDepth === 1 && c === COLON) {
        this.wAfterColon = true;
        i++;
        continue;
      }
      if (this.wDepth === 1 && this.wAfterColon && c === LBRACKET) {
        this.mode = "array";
        return i + 1;
      }
      if (this.wDepth === 1) this.wAfterColon = false;
      if (c === LBRACE || c === LBRACKET) this.wDepth++;
      else if (c === RBRACE || c === RBRACKET) {
        this.wDepth--;
        if (this.wDepth === 0) throw parseError("the export file holds no list");
      }
      i++;
    }
    return n;
  }

  /**
   * Inside a string at `i`: returns the index after the closing quote, or `buf.length` when the string continues
   * in the next chunk (the escape state is carried over).
   */
  private skipString(buf: Buffer, i: number): number {
    const n = buf.length;
    if (this.escape) {
      this.escape = false;
      i++;
      if (i >= n) return n;
    }
    for (;;) {
      const q = buf.indexOf(QUOTE, i);
      if (q < 0) {
        let k = 0;
        for (let j = n - 1; j >= i && buf[j] === BACKSLASH; j--) k++;
        this.escape = (k & 1) === 1;
        return n;
      }
      let k = 0;
      for (let j = q - 1; j >= i && buf[j] === BACKSLASH; j--) k++;
      if ((k & 1) === 1) {
        i = q + 1;
        if (i >= n) return n;
        continue;
      }
      this.inString = false;
      return q + 1;
    }
  }

  private begin(abs: number): void {
    this.elemStart = abs;
    this.elemKeep = this.index >= this.skip;
    this.elemTooLarge = false;
    this.parts = [];
    this.partsLen = 0;
  }

  /** The element ends just before `endInBuf` (exclusive). */
  private finish(buf: Buffer, base: number, endInBuf: number, out: Completed[]): void {
    const endAbs = base + endInBuf;
    const bytes = endAbs - this.elemStart;
    const done: Completed = { index: this.index, offset: this.elemStart, bytes, tooLarge: this.elemTooLarge || bytes > this.maxBytes };
    if (this.elemKeep && !done.tooLarge) {
      const from = Math.max(0, this.elemStart - base);
      const tail = buf.subarray(from, endInBuf);
      done.data = this.parts.length === 0 ? tail : Buffer.concat([...this.parts, tail], this.partsLen + tail.length);
    }
    if (this.index >= this.skip) out.push(done);
    this.index++;
    this.elemStart = -1;
    this.elemKeep = false;
    this.elemTooLarge = false;
    this.parts = [];
    this.partsLen = 0;
  }

  private scanArray(buf: Buffer, base: number, i: number, out: Completed[]): number {
    const n = buf.length;
    while (i < n) {
      if (this.inString) {
        i = this.skipString(buf, i);
        if (!this.inString && this.depth === 0) this.finish(buf, base, i, out);
        continue;
      }
      const c = buf[i]!;
      if (this.inPrimitive) {
        if (c === COMMA || c === RBRACKET || isWs(c)) {
          this.inPrimitive = false;
          this.finish(buf, base, i, out);
          continue;
        }
        i++;
        continue;
      }
      if (this.depth === 0) {
        if (c === COMMA || isWs(c)) {
          i++;
          continue;
        }
        if (c === RBRACKET) {
          this.mode = "done";
          return n;
        }
        if (c === RBRACE) throw parseError("the export list is malformed");
        this.begin(base + i);
        if (c === LBRACE || c === LBRACKET) this.depth = 1;
        else if (c === QUOTE) this.inString = true;
        else this.inPrimitive = true;
        i++;
        continue;
      }
      if (c === QUOTE) this.inString = true;
      else if (c === LBRACE || c === LBRACKET) this.depth++;
      else if (c === RBRACE || c === RBRACKET) {
        this.depth--;
        if (this.depth === 0) {
          this.finish(buf, base, i + 1, out);
          i++;
          continue;
        }
      }
      i++;
    }
    return n;
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw parseError("the export stream produced an unexpected chunk");
}

function cancelled(): CortexError {
  return new CortexError("E_CANCELLED", "cancelled");
}

async function* scanStream(input: Readable, opts: JsonArrayStreamOptions, keepFrom: number): AsyncGenerator<Completed> {
  const max = opts.maxElementBytes ?? DEFAULT_MAX_ELEMENT_BYTES;
  if (!Number.isFinite(max) || max <= 0) throw new CortexError("E_BAD_REQUEST", "maxElementBytes must be positive");
  const scanner = new JsonArrayScanner(keepFrom, max);
  const out: Completed[] = [];
  try {
    for await (const raw of input) {
      if (opts.signal?.aborted) throw cancelled();
      const chunk = toBuffer(raw);
      opts.onChunk?.(chunk);
      if (scanner.finished) continue; // read the rest so a hash in onChunk covers every byte
      scanner.push(chunk, out);
      for (const done of out) yield done;
      out.length = 0;
    }
    if (opts.signal?.aborted) throw cancelled();
    scanner.end();
  } finally {
    if (!input.destroyed) input.destroy();
  }
}

/** Yield each element of the top-level array in order, with its index and byte position. */
export async function* streamJsonArrayElements<T = unknown>(input: Readable, opts: JsonArrayStreamOptions = {}): AsyncGenerator<JsonArrayElement<T>> {
  const skip = Math.max(0, Math.floor(opts.skip ?? 0));
  for await (const done of scanStream(input, opts, skip)) {
    const info = { index: done.index, offset: done.offset, bytes: done.bytes };
    if (done.tooLarge || done.data === undefined) {
      if (!opts.onSkip) throw parseError(`an element of the export is larger than ${opts.maxElementBytes ?? DEFAULT_MAX_ELEMENT_BYTES} bytes`);
      opts.onSkip({ ...info, reason: "too-large" });
      continue;
    }
    let value: T;
    try {
      value = JSON.parse(done.data.toString("utf8")) as T;
    } catch {
      if (!opts.onSkip) throw parseError(`element ${done.index} of the export is not valid JSON`);
      opts.onSkip({ ...info, reason: "invalid-json" });
      continue;
    }
    yield { value, ...info };
  }
}

/** Yield each element of the top-level array in order (values only). */
export async function* streamJsonArray<T = unknown>(input: Readable, opts: JsonArrayStreamOptions = {}): AsyncGenerator<T> {
  for await (const el of streamJsonArrayElements<T>(input, opts)) yield el.value;
}

/** Count the elements without parsing any of them (one fast pass; pair with `onChunk` to hash the input). */
export async function scanJsonArray(input: Readable, opts: Omit<JsonArrayStreamOptions, "skip" | "onSkip"> = {}): Promise<JsonArrayScan> {
  const scanner = new JsonArrayScanner(Number.POSITIVE_INFINITY, opts.maxElementBytes ?? DEFAULT_MAX_ELEMENT_BYTES);
  const sink: Completed[] = [];
  let bytes = 0;
  try {
    for await (const raw of input) {
      if (opts.signal?.aborted) throw cancelled();
      const chunk = toBuffer(raw);
      bytes += chunk.length;
      opts.onChunk?.(chunk);
      if (!scanner.finished) scanner.push(chunk, sink);
    }
    if (opts.signal?.aborted) throw cancelled();
    scanner.end();
  } finally {
    if (!input.destroyed) input.destroy();
  }
  return { count: scanner.count, bytes };
}
