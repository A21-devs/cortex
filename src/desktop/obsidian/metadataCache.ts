/**
 * Obsidian's metadataCache for Cortex Desktop, computed by parsing the vault's markdown (markdown.ts): per-file
 * frontmatter, links, embeds, frontmatter links, tags and headings, plus `resolvedLinks` / `unresolvedLinks` and
 * getFirstLinkpathDest(). The first full pass finishes before Cortex loads (so vault.cxi is never built from a
 * half-read cache); afterwards changed files are re-read and "changed" then "resolved" fire, as in Obsidian.
 */
import { readFile } from "node:fs/promises";
import { Events } from "./events";
import { LinkResolver, getLinkpath, parseMarkdownMetadata, resolveFileLinks, type CachedMetadata } from "./markdown";
import type { TFile, Vault, VaultChange } from "./vault";

async function mapLimit<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const k = next++;
        if (k >= items.length) return;
        await fn(items[k] as T);
      }
    }),
  );
}

export interface MetadataLoadStats {
  files: number;
  markdown: number;
  unreadable: number;
  ms: number;
}

export class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  /** True once the first pass is done. */
  initialized = false;
  private readonly caches = new Map<string, CachedMetadata>();
  private readonly resolver = new LinkResolver();

  constructor(private readonly vault: Vault) {
    super();
  }

  getFileCache(file: TFile | null | undefined): CachedMetadata | null {
    return file ? (this.caches.get(file.path) ?? null) : null;
  }

  getCache(path: string): CachedMetadata | null {
    return this.caches.get(path) ?? null;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const dest = this.resolver.resolve(getLinkpath(linkpath), sourcePath);
    return dest ? this.vault.getFileByPath(dest) : null;
  }

  /** The shortest link text that still resolves to `file` from `sourcePath` (Obsidian's default link format). */
  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    const full = omitMdExtension && file.extension === "md" ? file.path.slice(0, -3) : file.path;
    const short = omitMdExtension && file.extension === "md" ? file.basename : file.name;
    return this.resolver.resolve(short, sourcePath) === file.path ? short : full;
  }

  private async parse(file: TFile): Promise<boolean> {
    try {
      const text = await readFile(this.vault.adapter.getFullPath(file.path), "utf8");
      this.caches.set(file.path, parseMarkdownMetadata(text));
      return true;
    } catch {
      // Not readable right now (OneDrive placeholder, locked): Obsidian would also have no cache for it.
      this.caches.set(file.path, {});
      return false;
    }
  }

  private resolveOne(path: string): void {
    const { resolved, unresolved } = resolveFileLinks(this.caches.get(path), path, this.resolver);
    this.resolvedLinks[path] = resolved;
    this.unresolvedLinks[path] = unresolved;
  }

  private resolveAll(): void {
    const resolved: Record<string, Record<string, number>> = {};
    const unresolved: Record<string, Record<string, number>> = {};
    for (const path of this.caches.keys()) {
      const r = resolveFileLinks(this.caches.get(path), path, this.resolver);
      resolved[path] = r.resolved;
      unresolved[path] = r.unresolved;
    }
    this.resolvedLinks = resolved;
    this.unresolvedLinks = unresolved;
  }

  /** The first pass over the whole vault (after vault.load()). */
  async initialize(onProgress?: (done: number, total: number) => void): Promise<MetadataLoadStats> {
    const t0 = Date.now();
    const all = this.vault.getFiles();
    for (const f of all) this.resolver.add(f.path);
    const md = all.filter((f) => f.extension === "md");
    let done = 0;
    let unreadable = 0;
    await mapLimit(md, 32, async (f) => {
      if (!(await this.parse(f))) unreadable++;
      done++;
      if (onProgress && done % 500 === 0) onProgress(done, md.length);
    });
    this.resolveAll();
    this.initialized = true;
    this.trigger("resolved");
    return { files: all.length, markdown: md.length, unreadable, ms: Date.now() - t0 };
  }

  /** Apply one batch of watched changes: re-read changed notes, re-resolve, then "changed" and "resolved". */
  async applyChanges(c: VaultChange): Promise<void> {
    for (const f of c.deleted) {
      this.resolver.remove(f.path);
      const prev = this.caches.get(f.path);
      this.caches.delete(f.path);
      delete this.resolvedLinks[f.path];
      delete this.unresolvedLinks[f.path];
      if (prev) this.trigger("deleted", f, prev);
    }
    for (const f of c.created) this.resolver.add(f.path);
    const touched = [...c.created, ...c.modified].filter((f) => f.extension === "md");
    await mapLimit(touched, 16, async (f) => {
      await this.parse(f);
    });
    if (c.setChanged) this.resolveAll();
    else for (const f of touched) this.resolveOne(f.path);
    for (const f of touched) {
      const cache = this.caches.get(f.path);
      if (cache) this.trigger("changed", f, "", cache);
    }
    this.trigger("resolved");
  }
}

