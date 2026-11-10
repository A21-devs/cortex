/**
 * Obsidian's `Events` for Cortex Desktop: named listeners with `on` / `off` / `offref` / `trigger`. A listener that
 * throws is reported to the console and never stops the others (as in Obsidian).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Listener = (...data: any[]) => unknown;

export interface EventRef {
  readonly e: Events;
  readonly name: string;
  readonly fn: Listener;
  readonly ctx?: unknown;
}

export class Events {
  private readonly listeners = new Map<string, EventRef[]>();

  on(name: string, callback: Listener, ctx?: unknown): EventRef {
    const ref: EventRef = ctx === undefined ? { e: this, name, fn: callback } : { e: this, name, fn: callback, ctx };
    const list = this.listeners.get(name);
    if (list) list.push(ref);
    else this.listeners.set(name, [ref]);
    return ref;
  }

  off(name: string, callback: Listener): void {
    const list = this.listeners.get(name);
    if (!list) return;
    const next = list.filter((r) => r.fn !== callback);
    if (next.length > 0) this.listeners.set(name, next);
    else this.listeners.delete(name);
  }

  offref(ref: EventRef | null | undefined): void {
    if (!ref || ref.e !== this) return;
    const list = this.listeners.get(ref.name);
    if (!list) return;
    const next = list.filter((r) => r !== ref);
    if (next.length > 0) this.listeners.set(ref.name, next);
    else this.listeners.delete(ref.name);
  }

  trigger(name: string, ...data: unknown[]): void {
    const list = this.listeners.get(name);
    if (!list) return;
    for (const ref of [...list]) this.tryTrigger(ref, data);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    try {
      ref.fn.apply(ref.ctx, args);
    } catch (e) {
      console.error(`[cortex-desktop] "${ref.name}" listener failed`, e);
    }
  }

  /** Listeners currently registered for an event (tests and diagnostics). */
  listenerCount(name: string): number {
    return this.listeners.get(name)?.length ?? 0;
  }
}
