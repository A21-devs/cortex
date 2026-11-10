/**
 * A small logger so modules never call console directly. Owner: E1.
 *
 * Privacy rule for every caller: never log record text, prompts or model output bodies; log ids, counts, codes
 * and timings. Sinks are isolated: a sink that throws never breaks the code that logged. `createRingSink` keeps
 * the most recent entries in memory for Export diagnostics (codes and counts only, never written anywhere
 * unless the user exports them).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export type LogSink = (level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>) => void;

function safeCall(sink: LogSink, level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
  try {
    sink(level, scope, msg, data);
  } catch {
    // A broken sink must never break the caller.
  }
}

export function createLogger(scope: string, sink: LogSink, debugEnabled: () => boolean): Logger {
  const isDebug = (): boolean => {
    try {
      return debugEnabled();
    } catch {
      return false;
    }
  };
  return {
    debug: (msg, data) => {
      if (isDebug()) safeCall(sink, "debug", scope, msg, data);
    },
    info: (msg, data) => safeCall(sink, "info", scope, msg, data),
    warn: (msg, data) => safeCall(sink, "warn", scope, msg, data),
    error: (msg, data) => safeCall(sink, "error", scope, msg, data),
    child: (sub) => createLogger(`${scope}:${sub}`, sink, debugEnabled),
  };
}

export const consoleSink: LogSink = (level, scope, msg, data) => {
  const line = `[cortex:${scope}] ${msg}`;
  const fn = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
  if (data === undefined) fn(line);
  else fn(line, data);
};

/** Fan out to several sinks (each isolated). */
export function teeSink(...sinks: LogSink[]): LogSink {
  return (level, scope, msg, data) => {
    for (const s of sinks) safeCall(s, level, scope, msg, data);
  };
}

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface RingSink {
  readonly sink: LogSink;
  /** Entries oldest first. */
  entries(): LogEntry[];
  clear(): void;
}

/** Keep the last `capacity` entries at or above `minLevel` in memory. */
export function createRingSink(capacity = 200, minLevel: LogLevel = "warn", now: () => number = () => Date.now()): RingSink {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const cap = Math.max(1, Math.floor(capacity));
  const buf: LogEntry[] = [];
  let start = 0;
  return {
    sink: (level, scope, msg, data) => {
      if (order[level] < order[minLevel]) return;
      const e: LogEntry = { at: new Date(now()).toISOString(), level, scope, msg };
      if (data !== undefined) e.data = data;
      if (buf.length < cap) buf.push(e);
      else {
        buf[start] = e;
        start = (start + 1) % cap;
      }
    },
    entries: () => [...buf.slice(start), ...buf.slice(0, start)],
    clear: () => {
      buf.length = 0;
      start = 0;
    },
  };
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};
