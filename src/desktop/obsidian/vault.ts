/**
 * Obsidian's vault over the real folder, for Cortex Desktop: TFile / TFolder objects for every file Obsidian would
 * show (names starting with "." are hidden, as in Obsidian; symbolic links are not followed), reads, stats and a
 * recursive fs.watch that reports create / modify / delete.
 *
 * Read-only by construction: every vault write method rejects. Cortex writes its own files through the store
 * layer (minted paths), never through this adapter. The one writable area is the plugin's data folder
 * (`.obsidian/plugins/cortex` as Cortex sees it), which is mounted on the desktop's own data folder under
 * %APPDATA%\Cortex: `data.json` is read from there, falling back to the vault's copy (read-only) until the desktop
 * has its own, and every write lands in the desktop folder (or in memory in view-only runs).
 *
 * Differences from Obsidian (approximations): a rename is reported as delete + create, ctime is the file's birth
 * time (as Obsidian does on Windows), and `.obsidian/app.json` is read once at start (getConfig).
 */
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { Events } from "./events";

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export interface Stat extends FileStats {
  type: "file" | "folder";
}

export class ReadOnlyVaultError extends Error {
  constructor(what: string) {
    super(`Cortex Desktop does not write into the vault (${what})`);
    this.name = "ReadOnlyVaultError";
  }
}

export abstract class TAbstractFile {
  parent: TFolder | null = null;
  constructor(
    readonly vault: Vault,
    public path: string,
    public name: string,
  ) {}
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  constructor(vault: Vault, path: string, public stat: FileStats) {
    super(vault, path, path.slice(path.lastIndexOf("/") + 1));
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  constructor(vault: Vault, path: string) {
    super(vault, path, path === "" ? "" : path.slice(path.lastIndexOf("/") + 1));
  }
  isRoot(): boolean {
    return this.path === "";
  }
}

// No-break spaces (U+00A0, U+202F) read as plain spaces in paths, as in Obsidian's normalizePath.
const NO_BREAK_SPACES = new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`, "g");

/** Normalise a vault-relative path like Obsidian's normalizePath (slashes, spaces); names keep their on-disk form. */
export function normalizePath(p: string): string {
  return p
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(NO_BREAK_SPACES, " ");
}

/** True when Obsidian hides the path (a name starting with "." anywhere on it). */
export function isHiddenPath(rel: string): boolean {
  return rel.split("/").some((seg) => seg.startsWith("."));
}

export function statsOf(s: { birthtimeMs: number; ctimeMs: number; mtimeMs: number; size: number }): FileStats {
  const birth = Math.round(s.birthtimeMs);
  return { ctime: birth > 0 ? birth : Math.round(s.ctimeMs), mtime: Math.round(s.mtimeMs), size: s.size };
}

// ───────────────────────────── the plugin's data folder ─────────────────────────────

export interface PluginDataMount {
  /** The folder as Cortex names it (manifest.dir), e.g. ".obsidian/plugins/cortex". */
  vaultDir: string;
  /** Where the desktop keeps it: %APPDATA%\Cortex\vaults\<vaultKey>. */
  localDir: string;
  /** The vault's own plugin folder: read for data.json until the desktop has one; never written. */
  seedDir: string | null;
  /** View-only runs (the screenshot harness) keep every write in memory. */
  readOnly: boolean;
}

class MountedFolder {
  private readonly memory = new Map<string, string>();
  constructor(readonly m: PluginDataMount) {}

  /** The path inside the mount, or null when `p` is elsewhere in the vault. */
  inside(p: string): string | null {
    const n = normalizePath(p);
    const dir = normalizePath(this.m.vaultDir);
    if (n === dir) return "";
    return n.startsWith(`${dir}/`) ? n.slice(dir.length + 1) : null;
  }

  private local(rel: string): string {
    return nodePath.join(this.m.localDir, ...rel.split("/"));
  }

  private seed(rel: string): string | null {
    return this.m.seedDir && rel === "data.json" ? nodePath.join(this.m.seedDir, "data.json") : null;
  }

  async exists(rel: string): Promise<boolean> {
    if (rel === "" || this.memory.has(rel) || existsSync(this.local(rel))) return true;
    const s = this.seed(rel);
    return s !== null && existsSync(s);
  }

  async read(rel: string): Promise<string> {
    const mem = this.memory.get(rel);
    if (mem !== undefined) return mem;
    try {
      return await readFile(this.local(rel), "utf8");
    } catch (e) {
      const s = this.seed(rel);
      if (s && (e as { code?: string }).code === "ENOENT") return readFile(s, "utf8");
      throw e;
    }
  }

  async write(rel: string, data: string): Promise<void> {
    if (rel === "" || rel.split("/").some((seg) => seg === ".." || seg === "")) throw new ReadOnlyVaultError(`bad path ${rel}`);
    if (this.m.readOnly) {
      this.memory.set(rel, data);
      return;
    }
    const target = this.local(rel);
    await mkdir(nodePath.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
    await writeFile(tmp, data, "utf8");
    await rename(tmp, target);
  }
}

// ───────────────────────────── adapter ─────────────────────────────

export class FileSystemAdapter {
  private readonly mount: MountedFolder | null;

  constructor(
    private readonly basePath: string,
    mount: PluginDataMount | null = null,
  ) {
    this.mount = mount ? new MountedFolder(mount) : null;
  }

  getName(): string {
    return nodePath.basename(this.basePath);
  }

  getBasePath(): string {
    return this.basePath;
  }

  getFullPath(normalizedPath: string): string {
    const n = normalizePath(normalizedPath);
    return n === "" ? this.basePath : nodePath.join(this.basePath, ...n.split("/"));
  }

  getFilePath(normalizedPath: string): string {
    return pathToFileURL(this.getFullPath(normalizedPath)).href;
  }

  getResourcePath(normalizedPath: string): string {
    return this.getFilePath(normalizedPath);
  }

  async exists(normalizedPath: string, _sensitive?: boolean): Promise<boolean> {
    const rel = this.mount?.inside(normalizedPath);
    if (rel !== null && rel !== undefined) return this.mount!.exists(rel);
    return existsSync(this.getFullPath(normalizedPath));
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    try {
      const s = await stat(this.getFullPath(normalizedPath));
      return { type: s.isDirectory() ? "folder" : "file", ...statsOf(s) };
    } catch {
      return null;
    }
  }

  async read(normalizedPath: string): Promise<string> {
    const rel = this.mount?.inside(normalizedPath);
    if (rel !== null && rel !== undefined) return this.mount!.read(rel);
    return readFile(this.getFullPath(normalizedPath), "utf8");
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const b = await readFile(this.getFullPath(normalizedPath));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  async list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }> {
    const base = normalizePath(normalizedPath);
    const files: string[] = [];
    const folders: string[] = [];
    for (const e of await readdir(this.getFullPath(base), { withFileTypes: true })) {
      const p = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) folders.push(p);
      else if (e.isFile()) files.push(p);
    }
    return { files, folders };
  }

  /** Writes reach only the plugin's own data folder (mounted outside the vault); anything else is refused. */
  async write(normalizedPath: string, data: string): Promise<void> {
    const rel = this.mount?.inside(normalizedPath);
    if (rel === null || rel === undefined) throw new ReadOnlyVaultError(`write ${normalizedPath}`);
    await this.mount!.write(rel, data);
  }

  async append(normalizedPath: string, data: string): Promise<void> {
    const rel = this.mount?.inside(normalizedPath);
    if (rel === null || rel === undefined) throw new ReadOnlyVaultError(`append ${normalizedPath}`);
    const before = (await this.mount!.exists(rel)) ? await this.mount!.read(rel) : "";
    await this.mount!.write(rel, before + data);
  }

  async mkdir(normalizedPath: string): Promise<void> {
    if (this.mount?.inside(normalizedPath) === null || this.mount === null) throw new ReadOnlyVaultError(`mkdir ${normalizedPath}`);
  }

  async writeBinary(normalizedPath: string): Promise<void> {
    throw new ReadOnlyVaultError(`write ${normalizedPath}`);
  }

  async remove(normalizedPath: string): Promise<void> {
    throw new ReadOnlyVaultError(`remove ${normalizedPath}`);
  }

  async rmdir(normalizedPath: string): Promise<void> {
    throw new ReadOnlyVaultError(`rmdir ${normalizedPath}`);
  }

  async rename(normalizedPath: string): Promise<void> {
    throw new ReadOnlyVaultError(`rename ${normalizedPath}`);
  }

  async copy(normalizedPath: string): Promise<void> {
    throw new ReadOnlyVaultError(`copy ${normalizedPath}`);
  }

  async trashSystem(normalizedPath: string): Promise<boolean> {
    throw new ReadOnlyVaultError(`trash ${normalizedPath}`);
  }

  async trashLocal(normalizedPath: string): Promise<void> {
    throw new ReadOnlyVaultError(`trash ${normalizedPath}`);
  }
}

// ───────────────────────────── vault ─────────────────────────────

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

export interface VaultChange {
  created: TFile[];
  modified: TFile[];
  deleted: TFile[];
  /** True when files appeared or disappeared (links elsewhere may resolve differently). */
  setChanged: boolean;
}

const WATCH_DEBOUNCE_MS = 250;
const READ_CACHE_MAX = 64;

export class Vault extends Events {
  readonly configDir = ".obsidian";
  private readonly files = new Map<string, TAbstractFile>();
  private readonly root: TFolder;
  private config: Record<string, unknown> = {};
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly readCache = new Map<string, { mtime: number; size: number; text: string }>();
  /** Called after a batch of watched changes has been applied (the metadata cache follows). */
  onChanges: ((c: VaultChange) => Promise<void> | void) | null = null;

  constructor(readonly adapter: FileSystemAdapter) {
    super();
    this.root = new TFolder(this, "");
    this.files.set("", this.root);
  }

  getName(): string {
    return this.adapter.getName();
  }

  getRoot(): TFolder {
    return this.root;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(normalizePath(path)) ?? null;
  }

  getFileByPath(path: string): TFile | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.files.values()];
  }

  getAllFolders(includeRoot = false): TFolder[] {
    return [...this.files.values()].filter((f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()));
  }

  getFiles(): TFile[] {
    const out: TFile[] = [];
    for (const f of this.files.values()) if (f instanceof TFile) out.push(f);
    return out;
  }

  getMarkdownFiles(): TFile[] {
    const out: TFile[] = [];
    for (const f of this.files.values()) if (f instanceof TFile && f.extension === "md") out.push(f);
    return out;
  }

  /** Obsidian's vault config (`.obsidian/app.json`), read once at start; Cortex asks for userIgnoreFilters. */
  getConfig(key: string): unknown {
    return this.config[key];
  }

  async read(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async cachedRead(file: TFile): Promise<string> {
    const hit = this.readCache.get(file.path);
    if (hit && hit.mtime === file.stat.mtime && hit.size === file.stat.size) return hit.text;
    const text = await this.adapter.read(file.path);
    this.readCache.delete(file.path);
    this.readCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, text });
    if (this.readCache.size > READ_CACHE_MAX) this.readCache.delete(this.readCache.keys().next().value as string);
    return text;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  getResourcePath(file: TFile): string {
    return `${this.adapter.getResourcePath(file.path)}?${file.stat.mtime}`;
  }

  // Every vault write is refused: Cortex Desktop never changes notes through the vault API.
  async create(path: string): Promise<TFile> {
    throw new ReadOnlyVaultError(`create ${path}`);
  }
  async createBinary(path: string): Promise<TFile> {
    throw new ReadOnlyVaultError(`create ${path}`);
  }
  async createFolder(path: string): Promise<TFolder> {
    throw new ReadOnlyVaultError(`create ${path}`);
  }
  async modify(file: TFile): Promise<void> {
    throw new ReadOnlyVaultError(`modify ${file.path}`);
  }
  async modifyBinary(file: TFile): Promise<void> {
    throw new ReadOnlyVaultError(`modify ${file.path}`);
  }
  async append(file: TFile): Promise<void> {
    throw new ReadOnlyVaultError(`append ${file.path}`);
  }
  async process(file: TFile): Promise<string> {
    throw new ReadOnlyVaultError(`process ${file.path}`);
  }
  async delete(file: TAbstractFile): Promise<void> {
    throw new ReadOnlyVaultError(`delete ${file.path}`);
  }
  async trash(file: TAbstractFile): Promise<void> {
    throw new ReadOnlyVaultError(`trash ${file.path}`);
  }
  async rename(file: TAbstractFile): Promise<void> {
    throw new ReadOnlyVaultError(`rename ${file.path}`);
  }
  async copy(file: TFile): Promise<TFile> {
    throw new ReadOnlyVaultError(`copy ${file.path}`);
  }

  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => unknown): void {
    const stack: TAbstractFile[] = [root];
    while (stack.length > 0) {
      const f = stack.pop() as TAbstractFile;
      cb(f);
      if (f instanceof TFolder) stack.push(...f.children);
    }
  }

  // ───────────── loading ─────────────

  private readConfig(): void {
    try {
      const raw = readFileSync(nodePath.join(this.adapter.getBasePath(), this.configDir, "app.json"), "utf8");
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) this.config = v as Record<string, unknown>;
    } catch {
      this.config = {};
    }
  }

  private folderFor(path: string): TFolder {
    const existing = this.files.get(path);
    if (existing instanceof TFolder) return existing;
    const slash = path.lastIndexOf("/");
    const parent = slash === -1 ? this.root : this.folderFor(path.slice(0, slash));
    const folder = new TFolder(this, path);
    folder.parent = parent;
    parent.children.push(folder);
    this.files.set(path, folder);
    return folder;
  }

  private addFile(path: string, s: FileStats): TFile {
    const slash = path.lastIndexOf("/");
    const parent = slash === -1 ? this.root : this.folderFor(path.slice(0, slash));
    const f = new TFile(this, path, s);
    f.parent = parent;
    parent.children.push(f);
    this.files.set(path, f);
    return f;
  }

  private dropEntry(f: TAbstractFile): TFile[] {
    const removed: TFile[] = [];
    const visit = (x: TAbstractFile): void => {
      if (x instanceof TFolder) for (const c of [...x.children]) visit(c);
      this.files.delete(x.path);
      this.readCache.delete(x.path);
      if (x instanceof TFile) removed.push(x);
    };
    visit(f);
    if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
    return removed;
  }

  /** Walk a folder (vault-relative) and return its visible files with their stats. */
  private async scanTree(rel: string): Promise<{ path: string; stat: FileStats }[]> {
    const dirs: string[] = [];
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(this.adapter.getFullPath(d), { withFileTypes: true });
      } catch {
        return;
      }
      const subs: Promise<void>[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) {
          dirs.push(p);
          subs.push(walk(p));
        } else if (e.isFile()) files.push(p);
      }
      await Promise.all(subs);
    };
    await walk(rel);
    for (const d of dirs) this.folderFor(normalizePath(d));
    const out: { path: string; stat: FileStats }[] = [];
    await mapLimit(files, 64, async (p) => {
      try {
        out.push({ path: normalizePath(p), stat: statsOf(await stat(this.adapter.getFullPath(p))) });
      } catch {
        // gone between the listing and the stat
      }
    });
    return out;
  }

  /** Load every visible file (no contents; the metadata cache reads markdown afterwards). */
  async load(): Promise<void> {
    this.readConfig();
    const found = await this.scanTree("");
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const f of found) this.addFile(f.path, f.stat);
  }

  /**
   * A folder event: a new folder is read whole; a known one is compared entry by entry (its own files and
   * subfolders only — a note edited deeper down reports itself), so an event on a big folder stays cheap.
   */
  private async syncFolder(rel: string, change: VaultChange): Promise<void> {
    const known = this.files.get(rel);
    if (!(known instanceof TFolder)) {
      if (known) change.deleted.push(...this.dropEntry(known));
      this.folderFor(rel);
      for (const f of await this.scanTree(rel)) {
        const nf = this.addFile(f.path, f.stat);
        change.created.push(nf);
        change.setChanged = true;
        this.trigger("create", nf);
      }
      return;
    }
    let entries;
    try {
      entries = await readdir(this.adapter.getFullPath(rel), { withFileTypes: true });
    } catch {
      return;
    }
    const onDisk = new Map<string, "file" | "folder">();
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) onDisk.set(rel ? `${rel}/${e.name}` : e.name, "folder");
      else if (e.isFile()) onDisk.set(rel ? `${rel}/${e.name}` : e.name, "file");
    }
    for (const child of [...known.children]) {
      const kind = onDisk.get(child.path);
      if (kind === (child instanceof TFolder ? "folder" : "file")) continue;
      const removed = this.dropEntry(child);
      change.deleted.push(...removed);
      change.setChanged = true;
      for (const f of removed) this.trigger("delete", f);
      if (child instanceof TFolder) this.trigger("delete", child);
    }
    for (const [p, kind] of onDisk) {
      if (this.files.has(p)) continue;
      if (kind === "folder") {
        await this.syncFolder(p, change);
        continue;
      }
      try {
        const nf = this.addFile(p, statsOf(await stat(this.adapter.getFullPath(p))));
        change.created.push(nf);
        change.setChanged = true;
        this.trigger("create", nf);
      } catch {
        // gone again
      }
    }
  }

  // ───────────── watching ─────────────

  /** Watch the vault folder recursively; changes are applied in batches after 250 ms of quiet. */
  startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.adapter.getBasePath(), { recursive: true }, (_type, filename) => {
        if (!filename) return;
        const rel = normalizePath(String(filename));
        if (rel === "" || isHiddenPath(rel)) return;
        this.pending.add(rel);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.flush(), WATCH_DEBOUNCE_MS);
      });
      this.watcher.on("error", (e) => console.warn("[cortex-desktop] vault watcher stopped", e));
    } catch (e) {
      console.warn("[cortex-desktop] vault watching is unavailable", e);
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const paths = [...this.pending].sort();
    this.pending.clear();
    const change: VaultChange = { created: [], modified: [], deleted: [], setChanged: false };
    for (const rel of paths) {
      let s: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        s = await stat(this.adapter.getFullPath(rel));
      } catch {
        s = null;
      }
      const known = this.files.get(rel);
      if (!s) {
        if (known && known !== this.root) {
          const removed = this.dropEntry(known);
          change.deleted.push(...removed);
          change.setChanged = true;
          for (const f of removed) this.trigger("delete", f);
          if (known instanceof TFolder) this.trigger("delete", known);
        }
        continue;
      }
      if (s.isDirectory()) {
        await this.syncFolder(rel, change);
        continue;
      }
      if (!s.isFile()) continue;
      const st = statsOf(s);
      if (known instanceof TFile) {
        if (known.stat.mtime !== st.mtime || known.stat.size !== st.size) {
          known.stat = st;
          this.readCache.delete(known.path);
          change.modified.push(known);
          this.trigger("modify", known);
        }
      } else if (!known) {
        const nf = this.addFile(rel, st);
        change.created.push(nf);
        change.setChanged = true;
        this.trigger("create", nf);
      }
    }
    if (change.created.length + change.modified.length + change.deleted.length === 0) return;
    try {
      await this.onChanges?.(change);
    } catch (e) {
      console.warn("[cortex-desktop] metadata update failed", e);
    }
  }
}
