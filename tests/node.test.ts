/**
 * Node foundations (owner E1): path guards and minted paths (SAFE-02), atomic and exclusive writes, temp-file
 * cleanup, local cache locks with rename-based stale breaking (LOCKS-SHARED-SYNCED), gzip, the byte-offset line
 * splitter (SPLITLINES-BYTES), discovery and safe spawn. All files live in the OS temp folder, never the vault.
 */
import { mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTempFiles, ensureCacheDir, ensureCortexRoots, readJsonIfExists, writeFileAtomic, writeFileExclusive, writeJsonAtomic } from "../src/node/fsAtomic";
import { gunzipToText, gzipText, readGzipText, writeGzipExclusive } from "../src/node/gz";
import { sha256Text } from "../src/node/hash";
import { ByteLineSplitter, trimCr } from "../src/node/lineSplitter";
import { acquireLock, lockFileName, withLock } from "../src/node/locks";
import { assertMinted, assertWritable, cacheWritablePath, forgetGitignoreChecks, normalizeVaultPath, resolveInVault, toVaultPath, writablePath, writeRoots } from "../src/node/paths";
import { claudeProjectSlug, defaultCacheDir } from "../src/node/platform";
import { assertExecutable, runProcess } from "../src/node/spawn";
import { sha256Hex } from "../src/shared/sha256";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "cortex-test-"));

describe("node/paths (SAFE-02)", () => {
  it("normalises and rejects traversal, absolute and reserved paths", () => {
    expect(normalizeVaultPath(".raw\\chats\\x.jsonl.gz")).toBe(".raw/chats/x.jsonl.gz");
    for (const bad of ["../x", "a/../b", "/abs", "C:/x", "a//b", "con/x", "a/nul.txt", "a/b.", "a/b ", "a/<b>"]) expect(() => normalizeVaultPath(bad), bad).toThrow();
  });
  it("allows only the hard-coded Cortex roots and protects the vault's generated areas", () => {
    expect(writeRoots()).toEqual([".raw/chats/", ".raw/written/", "wiki/derived/", ".vault-meta/cortex/", ".obsidian/plugins/cortex/"]);
    expect(assertWritable("wiki/derived/gists/2026/abc-plan.md")).toBe("wiki/derived/gists/2026/abc-plan.md");
    for (const bad of ["wiki/brain/x.md", "wiki/Brain.md", "wiki/kb/deep/roblox/reference/a.md", ".obsidian/graph.json", ".obsidian/plugins/brain-network/main.js", "wiki/notes.md", "wiki/derived/wiki-x.md", ".raw/.manifest.json", ".raw/roblox/x.md"]) {
      expect(() => assertWritable(bad), bad).toThrow();
    }
    expect(() => assertWritable(`.raw/chats/${"x".repeat(240)}.md`, "C:/Users/you/Notes/my-vault")).toThrow(/too long/);
  });
  it("mints writable paths only when the root's nested .gitignore exists, and the writers re-check", async () => {
    const vault = await tmp();
    expect(() => writablePath(vault, ".raw/chats/a.txt")).toThrow(/gitignore/);
    await ensureCortexRoots(vault);
    expect(await readFile(path.join(vault, ".raw", "chats", ".gitignore"), "utf8")).toBe("*\n");
    const p = writablePath(vault, ".raw/chats/a.txt");
    await writeFileAtomic(p, "one");
    expect(await readFile(p, "utf8")).toBe("one");
    await expect(writeFileAtomic(path.join(vault, "notes.md") as never, "x")).rejects.toThrow();
    expect(() => assertMinted(path.join(vault, "wiki", "x.md"))).toThrow();
    expect(toVaultPath(vault, p)).toBe(".raw/chats/a.txt");
    expect(() => resolveInVault(vault, "../x")).toThrow();
  });
  it("refuses to write through a linked folder that points outside the vault", async () => {
    const vault = await tmp();
    const outside = await tmp();
    await mkdir(path.join(vault, "wiki"), { recursive: true });
    await writeFile(path.join(outside, ".gitignore"), "*\n");
    await symlink(outside, path.join(vault, "wiki", "derived"), "junction");
    forgetGitignoreChecks();
    expect(() => writablePath(vault, "wiki/derived/gists/x.md")).toThrow(/linked folder/);
    // a normal folder is still fine
    await ensureCortexRoots(vault, [".raw/chats"]);
    forgetGitignoreChecks();
    expect(() => writablePath(vault, ".raw/chats/ok.txt")).not.toThrow();
  });
  it("mints cache paths only inside a marked cache folder", async () => {
    const cache = await tmp();
    expect(() => cacheWritablePath(cache, "state/x.json")).toThrow();
    await ensureCacheDir(cache);
    const p = cacheWritablePath(cache, "state/x.json");
    await writeJsonAtomic(p, { a: 1 });
    expect(await readJsonIfExists<{ a: number }>(p)).toEqual({ a: 1 });
    expect(() => cacheWritablePath(cache, "../escape")).toThrow();
  });
});

describe("node/fsAtomic", () => {
  it("publishes immutable files exclusively and never replaces them", async () => {
    const vault = await tmp();
    await ensureCortexRoots(vault);
    const p = writablePath(vault, ".raw/chats/claude-code/seg.jsonl.gz");
    await writeFileExclusive(p, "a");
    await expect(writeFileExclusive(p, "b")).rejects.toMatchObject({ detail: { exists: true } });
    expect(await readFile(p, "utf8")).toBe("a");
    const n = await writeGzipExclusive(writablePath(vault, ".raw/chats/claude-code/seg2.jsonl.gz"), "line\n");
    expect(n).toBeGreaterThan(0);
    expect(await readGzipText(path.join(vault, ".raw", "chats", "claude-code", "seg2.jsonl.gz"))).toBe("line\n");
    expect(await gunzipToText(await gzipText("héllo"))).toBe("héllo");
  });
  it("cleans only old temp files of dead writers", async () => {
    const dir = await tmp();
    const dead = path.join(dir, ".a.json.cortex-tmp-999999-abc");
    const mine = path.join(dir, `.b.json.cortex-tmp-${process.pid}-abc`);
    const other = path.join(dir, "keep.txt");
    for (const f of [dead, mine, other]) await writeFile(f, "x");
    const old = new Date(Date.now() - 3_600_000);
    for (const f of [dead, mine]) await utimes(f, old, old);
    expect(await cleanTempFiles(dir)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([path.basename(mine), "keep.txt"].sort());
  });
});

describe("node/locks (LOCKS-SHARED-SYNCED)", () => {
  it("serialises holders, breaks stale locks by rename and verifies tokens", async () => {
    const dir = await tmp();
    const a = await acquireLock(dir, "ledger/entries", { owner: "a", staleMs: 60_000 });
    await expect(acquireLock(dir, "ledger/entries", { owner: "b", staleMs: 60_000, waitMs: 0 })).rejects.toThrow();
    expect(await a.verify()).toBe(true);
    await a.release();
    const stale = path.join(dir, lockFileName("t"));
    await writeFile(stale, JSON.stringify({ owner: "ghost", token: "old", at: 0 }));
    const old = new Date(Date.now() - 120_000);
    await utimes(stale, old, old);
    const b = await acquireLock(dir, "t", { owner: "b", staleMs: 60_000, waitMs: 0 });
    expect(await b.verify()).toBe(true);
    await b.release();
    expect(await withLock(dir, "t", { owner: "c", staleMs: 60_000 }, async () => 42)).toBe(42);
  });
});

describe("node/lineSplitter (SPLITLINES-BYTES)", () => {
  it("reports absolute byte offsets across chunks and multi-byte characters", () => {
    const enc = new TextEncoder();
    const s = new ByteLineSplitter(100);
    const lines: { text: string; start: number; end: number }[] = [];
    const take = (l: { bytes: Uint8Array; start: number; end: number }) => lines.push({ text: new TextDecoder().decode(trimCr(l.bytes)), start: l.start, end: l.end });
    const all = enc.encode("ab\r\nné\nlast");
    s.push(all.subarray(0, 3), take);
    s.push(all.subarray(3, 7), take);
    s.push(all.subarray(7), take);
    expect(lines).toEqual([
      { text: "ab", start: 100, end: 104 },
      { text: "né", start: 104, end: 108 },
    ]);
    expect(s.consumed).toBe(108);
    expect(s.pending).toBe(4);
  });
});

describe("node/hash, platform, spawn", () => {
  it("hashes like the shared implementation", () => {
    expect(sha256Text("abc")).toBe(sha256Hex("abc"));
  });
  it("computes cache folders and project slugs", () => {
    expect(defaultCacheDir("abcdefghijklmnop")).toMatch(/cortex[\\/]abcdefghijklmnop$/);
    expect(() => defaultCacheDir("../x")).toThrow();
    expect(claudeProjectSlug("C:\\Users\\you\\Notes\\my-vault")).toBe("C--Users-you-Notes-my-vault");
  });
  it("refuses shell shims and runs a real executable", async () => {
    expect(() => assertExecutable("C:/x/claude.cmd")).toThrow();
    const r = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], { cwd: os.tmpdir(), timeoutMs: 10_000 });
    expect(r.stdout).toBe("ok");
    expect(r.code).toBe(0);
  });
});
