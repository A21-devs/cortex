/**
 * Loads the lazy chunk (src/lazyEntry.ts) on first use. Owner: E1.
 * In the built plugin the chunk is a deflated base64 string inside main.js (`__CORTEX_LAZY_SOURCE__`): it is compiled only now,
 * with main.js's own `require` (Obsidian's, which knows "obsidian"). From source (tests, type checks) it is an
 * ordinary dynamic import.
 */
import * as copyModule from "./ui/copy";

type LazyChunk = typeof import("./lazyEntry");

declare const require: (id: string) => unknown;

let chunk: Promise<LazyChunk> | null = null;

/** The built chunk is deflated + base64 (scripts/build-config.mjs packLazy); the plugin is desktop-only, so Node's zlib is there. */
function unpackLazy(packed: string): string {
  const zlib = require("zlib") as { inflateRawSync(b: Uint8Array): Uint8Array };
  return Buffer.from(zlib.inflateRawSync(Buffer.from(packed, "base64"))).toString("utf8");
}

export function loadLazy(): Promise<LazyChunk> {
  chunk ??= (async (): Promise<LazyChunk> => {
    if (typeof __CORTEX_LAZY_BUNDLED__ !== "undefined" && __CORTEX_LAZY_BUNDLED__) {
      const mod: { exports: Record<string, unknown> } = { exports: {} };
      // The chunk leaves the wording out (scripts/build-config.mjs, sharedCopyPlugin) and takes main.js's own copy.
      const shared = (id: string): unknown => (id === "cortex-shared/copy" ? copyModule : require(id));
      new Function("module", "exports", "require", unpackLazy(__CORTEX_LAZY_SOURCE__))(mod, mod.exports, shared);
      return mod.exports as unknown as LazyChunk;
    } else {
      return import("./lazyEntry");
    }
  })();
  chunk.catch(() => {
    chunk = null; // a failed load can be retried by the next command
  });
  return chunk;
}

export const lazyContainer = async (): Promise<LazyChunk["container"]> => (await loadLazy()).container;
export const lazyCommandRun = async (): Promise<LazyChunk["commandRun"]> => (await loadLazy()).commandRun;
export const lazyMount = async (): Promise<LazyChunk["mount"]> => (await loadLazy()).mount;
