/**
 * Small concurrency helpers for file-heavy passes. On Windows every open/stat/read waits on the disk and on
 * real-time virus scanning (about 1-3 ms each), so a pass that awaits one file at a time spends most of its wall
 * time idle: 20,000 notes took minutes. A few requests in flight keep the disk busy without holding many
 * files in memory.
 */

/** Run `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export interface Ahead<T, R> {
  item: T;
  /** False when `wanted` rejected the item: nothing was started for it. */
  wanted: boolean;
  /** The result of `run(item)` (absent when not wanted or when it threw). */
  result?: R;
  /** What `run(item)` threw. */
  error?: unknown;
}

/**
 * Walk `source` in order, starting `run(item)` for up to `limit` wanted items ahead of the consumer, and yield
 * each item with its outcome in the original order. Items for which `eager` is false (big files) start only when
 * the consumer reaches them, so the window never holds more than `limit` small reads. A consumer that stops early
 * leaves at most `limit` finished or running calls behind; they cannot fail loudly (errors are captured).
 */
export async function* readAhead<T, R>(
  source: AsyncIterable<T>,
  opts: { limit: number; wanted: (item: T) => boolean; eager?: (item: T) => boolean },
  run: (item: T) => Promise<R>,
): AsyncGenerator<Ahead<T, R>> {
  interface Slot {
    item: T;
    wanted: boolean;
    p?: Promise<{ result?: R; error?: unknown }>;
  }
  const it = source[Symbol.asyncIterator]();
  const queue: Slot[] = [];
  let ended = false;
  const start = (s: Slot): void => {
    s.p = run(s.item).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
  };
  try {
    for (;;) {
      while (!ended && queue.length < opts.limit) {
        const r = await it.next();
        if (r.done) {
          ended = true;
          break;
        }
        const s: Slot = { item: r.value, wanted: opts.wanted(r.value) };
        if (s.wanted && (opts.eager?.(r.value) ?? true)) start(s);
        queue.push(s);
      }
      const head = queue.shift();
      if (head === undefined) return;
      if (head.wanted && head.p === undefined) start(head);
      const out = head.p ? await head.p : {};
      yield { item: head.item, wanted: head.wanted, ...out };
    }
  } finally {
    await it.return?.(undefined);
  }
}
