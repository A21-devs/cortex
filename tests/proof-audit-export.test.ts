/**
 * proof-audit-export: the offline verifier recomputes a known root and fails on a tampered file; the proof folder, the
 * audit pack and the record export build, check out through the verifier, and leave out what they must. Calendars and
 * block services are fakes; nothing touches the network.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHandlers } from "../src/runner/commands";
import type { RunnerHost } from "../src/runner/host";
import { createCancelSource } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import type { RunnerContext } from "../src/shared/protocol/runner";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { CorrectionRecord, EntryRecord, ReadRecord } from "../src/shared/types";
import { sha256Text } from "../src/node/hash";
import { openZip } from "../src/importers/zip";
import { crc32Of, ZipWriter } from "../src/node/zip";
import { checkPublicStamps, merkleRoot, publishSeals, resetSealCache, sealHostKey, sealNewEntries, readSealChain } from "../src/store/dateEvidence";
import { exportRecord, isOpenSpace } from "../src/store/exportRecord";
import { decryptExportBytes, encryptExportBytes, encryptExportFile } from "../src/store/exportCrypto";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import { buildEntryProof, merklePath, proofPackFiles } from "../src/store/proof";
import { serializeOts, targetOf, type TsNode } from "../src/store/otsProof";
import { buildAuditPack } from "../src/store/auditPack";
import { VERIFIER_JS, VERIFIER_KEYS, buildVerifierHtml } from "../src/store/verifierPage";
import { verifierStrings } from "../src/plugin/verifierStrings";
import { COPY } from "../src/ui/copy";
import { heldVaultKey } from "../src/shared/crypto/keyring";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-pae-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => resetSealCache());

const T0 = Date.UTC(2026, 10, 3, 14, 0, 0);
const DAY = 24 * 3600 * 1000;
const EASY = 1e-12;
const B32 = "bcdefghijklmnopq";
const eId = (n: number): EntryRecord["id"] => `e_${"a".repeat(14)}${B32[Math.floor(n / 16)]}${B32[n % 16]}` as EntryRecord["id"];
const STRINGS = verifierStrings();

// the verifier page's own script, evaluated the way a browser would, with no DOM
interface Verifier {
  verifyFiles(files: { path: string; bytes: Uint8Array }[], opts?: { minDifficulty?: number }): Promise<{ ok: boolean; kind: string; lines: { key: string; ok: boolean | null; vars: Record<string, string> }[]; date: { state: string; at?: string; height?: number } | null; chain?: { blocks: number; confirmed: number; pending: number } }>;
  merkleRoot(leaves: string[]): Promise<string>;
  headline(S: Record<string, string>, rep: unknown): string;
  lineText(S: Record<string, string>, l: unknown): string;
}
const g = globalThis as unknown as { CortexVerify?: Verifier };
new Function(VERIFIER_JS)();
const V = g.CortexVerify as Verifier;
const file = (p: string, data: string | Uint8Array): { path: string; bytes: Uint8Array } => ({ path: p, bytes: typeof data === "string" ? new TextEncoder().encode(data) : data });
const keys = (r: { lines: { key: string; ok: boolean | null }[] }, ok: boolean | null): string[] => r.lines.filter((l) => l.ok === ok).map((l) => l.key);

// ───────────────────────────── world ─────────────────────────────

async function world() {
  const vault = tmp("vault");
  const cache = tmp("cache");
  mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  return { vault, cache, ctx, ledger: createLedgerStore(ctx) };
}
type W = Awaited<ReturnType<typeof world>>;

function entry(w: W, n: number, over: Omit<Partial<EntryRecord>, "text"> & { text?: string } = {}): EntryRecord {
  const text = over.text ?? `entry number ${n}: a private sentence ${"x".repeat(n)}`;
  const rel = `.raw/docs/e${n}.md`;
  mkdirSync(path.join(w.vault, ".raw/docs"), { recursive: true });
  writeFileSync(path.join(w.vault, rel), text);
  const sha = sha256Text(text);
  const iso = new Date(T0 + n * 60_000).toISOString();
  const { text: _t, ...rest } = over;
  return {
    v: 1, id: eId(n), kind: "message", source: "claude-code", sourceRef: { path: `C:\\Users\\someone\\e${n}.md`, nativeId: `n${n}`, sha256: sha }, conv: "c_aaaaaaaaaaaaaaaa", idx: n, speaker: "you",
    text: { store: "file", path: rel, byteStart: 0, byteEnd: Buffer.byteLength(text, "utf8") }, textSha256: sha, chars: text.length, words: 3, dates: [], existedBy: iso, addedAt: iso, writtenAt: iso, space: "roblox", folder: ["proj"],
    ...rest,
  } as unknown as EntryRecord;
}

// a fake calendar and a mined header, as in the seal tests
const CAL = "https://alice.btc.calendar.opentimestamps.org";
const A = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
const Bk = Buffer.from("a1a2a3a4a5a6a7a8a9aaabacadaeafb0", "hex");
const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();
const sha256d = (b: Uint8Array): Buffer => sha256(sha256(b));
const leaf = (n: Partial<TsNode>): TsNode => ({ attestations: [], ops: [], ...n });
const pendingTree = (): TsNode => leaf({ ops: [{ tag: 0xf0, arg: A, child: leaf({ ops: [{ tag: 0x08, child: leaf({ attestations: [{ kind: "pending", uri: CAL }] }) }] }) }] });
const tree = (root: TsNode): Buffer => serializeOts({ fileOp: 0x08, digest: new Uint8Array(32), root }).subarray(65);
function mineHeader(root: Uint8Array, time: number): Buffer {
  const h = Buffer.alloc(80);
  h.writeUInt32LE(0x20000000, 0);
  Buffer.from(root).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  const target = targetOf(0x207fffff)!;
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt(`0x${Buffer.from(sha256d(h)).reverse().toString("hex")}`) <= target) return h;
  }
}
const completed = (height: number): Buffer => tree(leaf({ ops: [{ tag: 0xf0, arg: Bk, child: leaf({ ops: [{ tag: 0x08, child: leaf({ attestations: [{ kind: "bitcoin", height }] }) }] }) }] }));

/** Seal the entries, stamp the newest block, and (optionally) confirm it against a mined header. */
async function sealed(w: W, opts: { confirm?: boolean; stamp?: boolean; format?: 1 | 2 } = {}) {
  await sealNewEntries(w.ctx, w.ledger, { now: () => T0, ...(opts.format ? { format: opts.format } : {}) });
  if (opts.stamp === false) return;
  await publishSeals(w.ctx, { post: async () => tree(pendingTree()), now: () => T0 + 1000 });
  if (opts.confirm) {
    const host = sealHostKey();
    const head = (await readSealChain(w.vault, host)).blocks.at(-1)!;
    const digest = head.v === 2 ? head.fp : head.hash;
    const commitment = sha256(Buffer.concat([Buffer.from(digest, "hex"), A]));
    const header = mineHeader(sha256(Buffer.concat([commitment, Bk])), Math.floor(T0 / 1000) + 3600);
    await checkPublicStamps(w.ctx, { get: async () => completed(850_123), header: async () => header, now: () => T0 + DAY, minDifficulty: EASY });
  }
}

const opts = { minDifficulty: EASY };

// ───────────────────────────── the verifier recomputes a known root ─────────────────────────────

describe("the offline verifier", () => {
  it("recomputes the same Merkle root as the sealing code, for every size and position", async () => {
    for (let n = 1; n <= 9; n++) {
      const leaves = Array.from({ length: n }, (_, i) => createHash("sha256").update(`leaf${i}`).digest("hex"));
      const root = merkleRoot(leaves);
      expect(await V.merkleRoot(leaves)).toBe(root);
      for (let i = 0; i < n; i++) {
        let h = leaves[i]!;
        for (const s of merklePath(leaves, i)) h = createHash("sha256").update(s.left ? s.h + h : h + s.h).digest("hex");
        expect(h).toBe(root);
      }
    }
    expect(await V.merkleRoot([])).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("has English for every key it uses and no key the copy lacks; the page forbids every request", () => {
    for (const k of VERIFIER_KEYS) expect(typeof (COPY.verifier as Record<string, string>)[k], k).toBe("string");
    expect(Object.keys(COPY.verifier).sort()).toEqual([...VERIFIER_KEYS].sort());
    const html = buildVerifierHtml(STRINGS, { name: "proof.json", json: "{}" });
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//);
    expect(VERIFIER_JS).not.toMatch(/[`]|\$\{/);
    // data is embedded as an inert block, with angle brackets escaped
    expect(buildVerifierHtml(STRINGS, { name: "x.json", json: JSON.stringify({ a: "</script><b>" }) })).not.toContain("</script><b>");
  });
});

// ───────────────────────────── prove this entry ─────────────────────────────

describe("Prove this entry", () => {
  it("builds a proof the verifier accepts, and reports the date the Bitcoin block supports", async () => {
    const w = await world();
    await w.ledger.append("entries", [0, 1, 2, 3, 4].map((n) => entry(w, n)));
    await sealed(w, { confirm: true });
    const proof = await buildEntryProof(w.ctx, w.ledger, eId(3));
    expect(proof.block.v).toBe(2);
    expect(proof.leafSalt).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.count).toBe(5);
    expect(proof.timestamp?.bitcoin?.height).toBe(850_123);
    expect(proof.entry.text).toContain("entry number 3");
    // the block head has no ids and carries no other entry's text
    expect(JSON.stringify(proof)).not.toContain("entry number 2");
    expect(proof.block).not.toHaveProperty("ids");

    const files = proofPackFiles(proof, STRINGS);
    expect(files.map((f) => f.name).sort()).toEqual(["README.txt", "block.json", "entry.txt", "proof.json", "signature.txt", "timestamp.ots", "verify.html"]);
    const r = await V.verifyFiles([file("proof.json", files.find((f) => f.name === "proof.json")!.data)], opts);
    expect(r.kind).toBe("entry");
    expect(r.ok).toBe(true);
    expect(keys(r, false)).toEqual([]);
    expect(r.date).toMatchObject({ state: "confirmed", height: 850_123 });
    expect(r.date!.at).toBe(new Date((Math.floor(T0 / 1000) + 3600) * 1000).toISOString());
    expect(V.headline(STRINGS, r)).toContain("existed by then");
    // the default work floor does not accept this easy test header: the date is not claimed
    const strict = await V.verifyFiles([file("proof.json", files.find((f) => f.name === "proof.json")!.data)]);
    expect(strict.ok).toBe(false);
    expect(strict.date).toEqual({ state: "none" });
  });

  it("fails when the text, the path, the block, the signature, the salt or the timestamp file is tampered with", async () => {
    const w = await world();
    await w.ledger.append("entries", [0, 1, 2].map((n) => entry(w, n)));
    await sealed(w, { confirm: true });
    const proof = await buildEntryProof(w.ctx, w.ledger, eId(1));
    const good = JSON.stringify(proof);
    const run = async (mutate: (p: any) => void) => {
      const p = JSON.parse(good);
      mutate(p);
      return V.verifyFiles([file("proof.json", JSON.stringify(p))], opts);
    };
    expect((await run(() => undefined)).ok).toBe(true);
    expect(keys(await run((p) => (p.entry.text += " (changed)")), false)).toContain("textHash");
    expect(keys(await run((p) => (p.path[0].h = "00".repeat(32))), false)).toContain("path");
    expect(keys(await run((p) => (p.entry.id = eId(0))), false)).toContain("path");
    expect(keys(await run((p) => (p.leafSalt = "11".repeat(32))), false)).toContain("path");
    expect(keys(await run((p) => (p.block.root = "22".repeat(32))), false)).toEqual(expect.arrayContaining(["path", "blockHash"]));
    expect(keys(await run((p) => (p.block.at = "2020-01-01T00:00:00.000Z")), false)).toContain("blockHash");
    // The last byte always changes (a signature that already ended in 00 made this a no-op, about 1 run in 256).
    expect(keys(await run((p) => (p.block.sig = `${p.block.sig.slice(0, 126)}${p.block.sig.slice(126) === "00" ? "ff" : "00"}`)), false)).toContain("signature");
    expect(keys(await run((p) => (p.timestamp.salt = "33".repeat(32))), false)).toContain("salt");
    const ots = Buffer.from(proof.timestamp!.ots, "base64");
    expect(keys(await run((p) => (p.timestamp.ots = Buffer.concat([ots.subarray(0, 40), Buffer.from([ots[40]! ^ 1]), ots.subarray(41)]).toString("base64"))), false).length).toBeGreaterThan(0);
    // a different header than the one the timestamp commits to
    const r = await run((p) => {
      const h = Buffer.from(p.timestamp.bitcoin.header, "hex");
      h[36]! ^= 1;
      p.timestamp.bitcoin.header = h.toString("hex");
    });
    expect(r.ok).toBe(false);
    expect(keys(r, false)).toContain("bitcoin");
    // a failed pack never claims a date
    expect(r.date).toEqual({ state: "none" });
    expect(V.headline(STRINGS, r)).toBe(STRINGS.headlineBad);
  });

  it("works for a version 1 block, for an unstamped block and for a stamp that Bitcoin has not confirmed", async () => {
    const w1 = await world();
    await w1.ledger.append("entries", [0, 1].map((n) => entry(w1, n)));
    await sealed(w1, { format: 1, stamp: false });
    const p1 = await buildEntryProof(w1.ctx, w1.ledger, eId(0));
    expect(p1.block.v).toBe(1);
    expect(p1.leafSalt).toBeUndefined();
    const r1 = await V.verifyFiles([file("proof.json", JSON.stringify(p1))], opts);
    expect(r1.ok).toBe(true);
    expect(r1.date).toMatchObject({ state: "sealed" });
    expect(keys(r1, null)).toEqual(expect.arrayContaining(["unsigned", "noStamp"]));

    const w2 = await world();
    await w2.ledger.append("entries", [0, 1, 2].map((n) => entry(w2, n)));
    await sealed(w2, { confirm: false });
    const p2 = await buildEntryProof(w2.ctx, w2.ledger, eId(2));
    const r2 = await V.verifyFiles([file("proof.json", JSON.stringify(p2))], opts);
    expect(r2.ok).toBe(true);
    expect(r2.date).toMatchObject({ state: "pending" });
    expect(V.headline(STRINGS, r2)).toContain("only the seal date stands");
  });

  it("joins an earlier block to the later block that was stamped", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(w, 0)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 });
    await w.ledger.append("entries", [entry(w, 1)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 1000 });
    await publishSeals(w.ctx, { post: async () => tree(pendingTree()), now: () => T0 + 2000 });
    const p = await buildEntryProof(w.ctx, w.ledger, eId(0));
    expect(p.links.map((l) => l.n)).toEqual([2]);
    expect(p.timestamp?.n).toBe(2);
    const r = await V.verifyFiles([file("proof.json", JSON.stringify(p))], opts);
    expect(r.ok).toBe(true);
    const bad = JSON.parse(JSON.stringify(p));
    bad.links[0].prev = "00".repeat(32);
    expect(keys(await V.verifyFiles([file("proof.json", JSON.stringify(bad))], opts), false)).toContain("links");
  });

  it("says why it cannot prove an entry: not found, not sealed, sealed first when allowed", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(w, 0)]);
    await expect(buildEntryProof(w.ctx, w.ledger, eId(9))).rejects.toMatchObject({ detail: { reason: "not-found" } });
    await expect(buildEntryProof(w.ctx, w.ledger, eId(0))).rejects.toMatchObject({ detail: { reason: "not-sealed" } });
    const p = await buildEntryProof(w.ctx, w.ledger, eId(0), { sealFirst: true, now: () => T0 });
    expect(p.block.n).toBe(1);
    expect(p.timestamp).toBeUndefined();
  });

  it("refuses text that was changed after sealing, and a block whose salt is on another computer", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(w, 0), entry(w, 1)]);
    await sealed(w, { stamp: false });
    writeFileSync(path.join(w.vault, ".raw/docs/e0.md"), "changed afterwards");
    await expect(buildEntryProof(w.ctx, w.ledger, eId(0))).rejects.toMatchObject({ detail: { reason: "text-missing" } });
    // The salts are kept with the record, so losing the local key store alone no longer loses them...
    rmSync(path.join(w.cache, "keys"), { recursive: true, force: true });
    expect((await buildEntryProof(w.ctx, w.ledger, eId(1))).block.n).toBe(1);
    // ...only a record that does not hold them (another computer's block whose salts were never synced) cannot be proved.
    for (const h of readdirSync(path.join(w.vault, ".vault-meta/cortex/seals"))) rmSync(path.join(w.vault, ".vault-meta/cortex/seals", h, "salts.json"), { force: true });
    await expect(buildEntryProof(w.ctx, w.ledger, eId(1))).rejects.toMatchObject({ detail: { reason: "salt-elsewhere" } });
  });

  it("writes a zip whose pieces are all there and whose page holds the proof", async () => {
    const w = await world();
    await w.ledger.append("entries", [0, 1].map((n) => entry(w, n)));
    await sealed(w, { confirm: true });
    const proof = await buildEntryProof(w.ctx, w.ledger, eId(0));
    const out = path.join(tmp("out"), "proof.zip");
    const { writePack } = await import("../src/store/sealPack");
    await writePack(out, proofPackFiles(proof, STRINGS));
    const zip = await openZip(out);
    expect(zip.entries.map((e) => e.name).sort()).toContain("verify.html");
    expect(zip.entries.map((e) => e.name)).toContain("timestamp.ots");
    await zip.close();
    expect(existsSync(`${out}.part`)).toBe(false);
  });
});

// ───────────────────────────── the zip writer ─────────────────────────────

describe("the zip writer", () => {
  it("round-trips names, bytes and checksums, and refuses unsafe names", async () => {
    const dir = tmp("zip");
    const out = path.join(dir, "a.zip");
    const z = new ZipWriter(out);
    const big = "hello ".repeat(5000);
    await z.add("a.txt", big);
    await z.add("dir/ü.bin", new Uint8Array([1, 2, 3]));
    await expect(z.add("../evil", "x")).rejects.toThrow();
    await expect(z.add("/abs", "x")).rejects.toThrow();
    await expect(z.add("a.txt", "dup")).rejects.toThrow();
    expect(await z.finish()).toMatchObject({ files: 2 });
    const zip = await openZip(out);
    expect(zip.entries.map((e) => e.name)).toEqual(["a.txt", "dir/ü.bin"]);
    const chunks: Buffer[] = [];
    for await (const c of await zip.open(zip.find("a.txt")!, { verifyCrc: true })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe(big);
    expect(zip.find("a.txt")!.method).toBe(8);
    expect(zip.find("a.txt")!.crc32).toBe(crc32Of(Buffer.from(big)));
    await zip.close();
  });

  it("leaves no file with the final name when it is aborted", async () => {
    const out = path.join(tmp("zip"), "b.zip");
    const z = new ZipWriter(out);
    await z.add("x", "y");
    await z.abort();
    expect(existsSync(out)).toBe(false);
  });

  it("matches the published CRC-32 check value", () => {
    expect(crc32Of(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

// ───────────────────────────── audit pack ─────────────────────────────

function read(id: string, over: Partial<ReadRecord>): ReadRecord {
  return { v: 1, runId: "r_aaaaaaaaaaaaaaaa", model: "claude-sonnet", engine: "claude-cli", where: "remote", entryIds: [eId(0)], noteIds: [], policy: "full+redacted", chars: 100, redactions: 2, withheld: 1, via: "job", origin: "plugin", at: new Date(T0).toISOString(), ...over } as unknown as ReadRecord;
}

describe("Audit pack", () => {
  it("holds the chain, anchors, key and aggregates, checks out, and carries no entry text, title or id", async () => {
    const w = await world();
    await w.ledger.append("entries", [0, 1, 2].map((n) => entry(w, n, { title: `private title ${n}` })));
    await sealed(w, { confirm: true });
    await w.ledger.append("reads", [
      read("1", { runId: "r_aaaaaaaaaaaaaaaa" as never, entryIds: [eId(0), eId(1)], redactions: 3, withheld: 0 }),
      read("2", { runId: "r_aaaaaaaaaaaaaaaa" as never, entryIds: [eId(2)], redactions: 1, withheld: 2, at: new Date(T0 + DAY).toISOString() }),
      read("3", { runId: "r_bbbbbbbbbbbbbbbb" as never, engine: "codex-cli", model: "gpt", entryIds: [eId(0)], redactions: 0, withheld: 0, at: new Date(T0 + 2 * DAY).toISOString() }),
    ]);
    const { audit, files } = await buildAuditPack(w.ctx, w.ledger, STRINGS, { now: () => T0 + 3 * DAY, cortexVersion: "9.9.9" });
    expect(audit.seals).toMatchObject({ computers: 1, blocks: 1, entries: 3 });
    expect(audit.keys).toHaveLength(1);
    expect(audit.keys[0]!.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){4}$/);
    expect(audit.access).toEqual([
      { model: "claude-sonnet", route: "Claude Code → Anthropic", itemsRead: 3, first: new Date(T0).toISOString(), last: new Date(T0 + DAY).toISOString() },
      { model: "gpt", route: "Codex CLI → OpenAI", itemsRead: 1, first: new Date(T0 + 2 * DAY).toISOString(), last: new Date(T0 + 2 * DAY).toISOString() },
    ]);
    expect(audit.redactions).toMatchObject({ reads: 3, items: 4, redactions: 4, withheld: 2 });
    expect(audit.redactions.byRoute[0]).toMatchObject({ model: "claude-sonnet", redactions: 4, withheld: 2, reads: 2 });
    expect(audit.redactions.byRun.find((r) => r.run === "r_aaaaaaaaaaaaaaaa")).toMatchObject({ reads: 2, redactions: 4, items: 3 });
    expect(audit.computers[0]!.stamps[0]!.bitcoin?.height).toBe(850_123);
    expect(audit.outward.some((o) => o.kind === "stamp")).toBe(true);
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["README.txt", "verify.html", "audit.json", `anchors/${sealHostKey()}-000001.ots`]));
    const json = files.find((f) => f.name === "audit.json")!.data as string;
    for (const secret of ["entry number", "private title", eId(0), eId(1), "someone"]) expect(json).not.toContain(secret);
    expect(files.find((f) => f.name === "verify.html")!.data).not.toContain("entry number");
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(audit)));

    // the page's checks, with the whole folder chosen
    const all = files.map((f) => file(f.name, f.data));
    const r = await V.verifyFiles(all, opts);
    expect(r.kind).toBe("audit");
    expect(r.ok).toBe(true);
    expect(keys(r, false)).toEqual([]);
    expect(r.chain).toMatchObject({ blocks: 1, confirmed: 1, pending: 0 });
    expect(r.lines.find((l) => l.key === "files")).toMatchObject({ ok: true, vars: { ok: "2", total: "2" } });
    // with only audit.json chosen the files are reported as not checked, not as passed
    const lonely = await V.verifyFiles([file("audit.json", json)], opts);
    expect(lonely.lines.find((l) => l.key === "files")!.ok).toBeNull();

    // tampering: a block, an anchor file, the README
    const bad = JSON.parse(json);
    bad.computers[0].blocks[0].count = 99;
    expect(keys(await V.verifyFiles([file("audit.json", JSON.stringify(bad))], opts), false)).toContain("chainHashes");
    const readme = all.map((f) => (f.path === "README.txt" ? file("README.txt", "edited") : f));
    expect(keys(await V.verifyFiles(readme, opts), false)).toContain("files");
    const anchors = all.map((f) => (f.path.startsWith("anchors/") ? file(f.path, new Uint8Array([...f.bytes.slice(0, 50), 0, ...f.bytes.slice(51)])) : f));
    expect(keys(await V.verifyFiles(anchors, opts), false)).toContain("files");
  });

  it("is honest for an empty record: no chain, nothing claimed", async () => {
    const w = await world();
    const { audit, files } = await buildAuditPack(w.ctx, w.ledger, STRINGS, { now: () => T0 });
    expect(audit.seals).toMatchObject({ blocks: 0, entries: 0 });
    const r = await V.verifyFiles(files.map((f) => file(f.name, f.data)), opts);
    expect(r.ok).toBe(true);
    expect(keys(r, null)).toContain("noChain");
  });
});

// ───────────────────────────── export my record ─────────────────────────────

async function readZip(out: string): Promise<Map<string, Buffer>> {
  const zip = await openZip(out);
  const m = new Map<string, Buffer>();
  for (const e of zip.entries) {
    const chunks: Buffer[] = [];
    for await (const c of await zip.open(e, { verifyCrc: true })) chunks.push(c as Buffer);
    m.set(e.name, Buffer.concat(chunks));
  }
  await zip.close();
  return m;
}
const asFiles = (m: Map<string, Buffer>) => [...m].map(([p, b]) => file(`export/${p}`, b));

describe("Export my record", () => {
  async function exportWorld() {
    const w = await world();
    const day = (d: number) => new Date(T0 + d * DAY).toISOString();
    await w.ledger.append("entries", [
      entry(w, 0, { space: "code", writtenAt: day(0), addedAt: day(0) }),
      entry(w, 1, { space: "code", writtenAt: day(40), addedAt: day(40), speaker: "assistant", speakerDetail: "claude-sonnet" }),
      entry(w, 2, { space: "life", writtenAt: day(1), addedAt: day(1), text: "a life entry\r\nwith two lines" }),
      entry(w, 3, { space: "money", writtenAt: day(2), addedAt: day(2), folder: ["private", "bank"] }),
      entry(w, 4, { space: "code", addedAt: day(3), writtenAt: undefined }),
      entry(w, 5, { space: "none", writtenAt: day(4), addedAt: day(4) }),
    ]);
    await sealed(w, { confirm: true });
    // a seventh entry arrives after sealing
    await w.ledger.append("entries", [entry(w, 6, { space: "code", writtenAt: day(5), addedAt: day(5) })]);
    return w;
  }

  it("skips closed areas by default, honours open areas and open folders, and says what it left out", async () => {
    expect(isOpenSpace("code", [], [])).toBe(false);
    expect(isOpenSpace("code", [], ["code"])).toBe(true);
    expect(isOpenSpace("money", ["private", "bank"], ["private"])).toBe(true);
    expect(isOpenSpace("money", ["private-x"], ["private"])).toBe(false);
    const w = await exportWorld();
    const out = path.join(tmp("out"), "all.zip");
    const none = await exportRecord(w.ctx, w.ledger, out, STRINGS, { now: () => T0 });
    expect(none).toMatchObject({ entries: 0, skippedClosed: 7 });
    const some = await exportRecord(w.ctx, w.ledger, path.join(tmp("out"), "code.zip"), STRINGS, { openSpaces: ["code"], now: () => T0 });
    expect(some).toMatchObject({ entries: 4, skippedClosed: 3 });
    const all = await exportRecord(w.ctx, w.ledger, out, STRINGS, { includeClosed: true, now: () => T0 });
    expect(all).toMatchObject({ entries: 7, skippedClosed: 0, excluded: 0, unreadable: 0, unsealed: 1 });
  });

  it("selects by area and period, writes markdown and JSON lines, and the manifest and seals check out in the verifier", async () => {
    const w = await exportWorld();
    const out = path.join(tmp("out"), "code.zip");
    const r = await exportRecord(w.ctx, w.ledger, out, STRINGS, { areas: ["code"], includeClosed: true, from: "2026-11-03", to: "2026-12-31", now: () => T0 + 10 * DAY, cortexVersion: "9.9.9" });
    // entries 0 (day 0, 2026-11-03), 1 (day 40, Dec 13), 4 (added day 3, no writing date), 6 (day 5)
    expect(r.entries).toBe(4);
    const z = await readZip(out);
    const names = [...z.keys()].sort();
    expect(names).toEqual(expect.arrayContaining(["README.txt", "manifest.json", "verify.html", "seals/seals.json", "seals/inclusion.json", `seals/anchors/${sealHostKey()}-000001.ots`, "entries/code/2026-11.md", "entries/code/2026-11.jsonl", "entries/code/2026-12.md"]));
    expect(names.some((n) => n.startsWith("entries/life") || n.startsWith("entries/money"))).toBe(false);
    const rows = z.get("entries/code/2026-11.jsonl")!.toString().trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((x) => x.id)).toEqual([eId(0), eId(4), eId(6)]);
    expect(rows[0]).toMatchObject({ sha256: sha256Text(rows[0].text), area: "code", speaker: "you", sourceName: "e0.md", seal: { computer: sealHostKey(), n: 1 } });
    expect(JSON.stringify(rows)).not.toContain("someone");
    expect(rows[1].writtenAt).toBeUndefined();
    expect(rows[2].seal).toBeUndefined();
    const md = z.get("entries/code/2026-11.md")!.toString();
    expect(md).toContain("# Code · 2026-11");
    expect(md).toContain("no writing date");
    expect(md).toContain(`id ${eId(0)}`);
    const dec = z.get("entries/code/2026-12.md")!.toString();
    expect(dec).toContain("assistant (claude-sonnet)");

    const files = asFiles(z);
    const v = await V.verifyFiles(files, opts);
    expect(v.kind).toBe("export");
    expect(v.ok).toBe(true);
    expect(keys(v, false)).toEqual([]);
    expect(v.lines.find((l) => l.key === "inclusion")).toMatchObject({ ok: true, vars: { ok: "3", bad: "0", unsealed: "1" } });
    expect(v.lines.find((l) => l.key === "roots")).toMatchObject({ ok: true });
    expect(v.lines.find((l) => l.key === "files")!.vars.total).toBe(String(JSON.parse(z.get("manifest.json")!.toString()).files.length));

    // tamper: a markdown file, the text in a row, a leaf
    const t1 = files.map((f) => (f.path.endsWith("2026-11.md") ? file(f.path, `${new TextDecoder().decode(f.bytes)}x`) : f));
    expect(keys(await V.verifyFiles(t1, opts), false)).toContain("files");
    const t2 = files.map((f) => (f.path.endsWith("2026-11.jsonl") ? file(f.path, new TextDecoder().decode(f.bytes).replace("entry number 0", "entry number X")) : f));
    const r2 = await V.verifyFiles(t2, opts);
    expect(r2.ok).toBe(false);
    expect(keys(r2, false)).toEqual(expect.arrayContaining(["rowText"]));
    const t3 = files.map((f) => {
      if (!f.path.endsWith("inclusion.json")) return f;
      const j = JSON.parse(new TextDecoder().decode(f.bytes));
      j.blocks[0].leaves[0] = "00".repeat(32);
      return file(f.path, JSON.stringify(j));
    });
    expect(keys(await V.verifyFiles(t3, opts), false)).toEqual(expect.arrayContaining(["roots"]));
    // a row whose fingerprint was changed together with its text still fails: it is not the sealed leaf
    const t4 = files.map((f) => {
      if (!f.path.endsWith("2026-11.jsonl")) return f;
      const lines = new TextDecoder().decode(f.bytes).trim().split("\n").map((l) => JSON.parse(l));
      lines[0].text = "forged";
      lines[0].sha256 = sha256Text("forged");
      return file(f.path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    });
    expect(keys(await V.verifyFiles(t4, opts), false)).toContain("inclusion");
  });

  it("leaves out entries the owner excluded, keeps corrections apart from the sealed original, and lists unreadable text", async () => {
    const w = await exportWorld();
    const at = new Date(T0).toISOString();
    const corr = (r: Partial<CorrectionRecord> & Record<string, unknown>) => ({ v: 1, id: `k_${Math.random().toString(36).slice(2, 18).padEnd(16, "a")}`, at, via: "reader", ...r }) as unknown as CorrectionRecord;
    await w.ledger.appendCorrections([
      corr({ action: "exclude", target: eId(2), payload: { scope: "entry" } }),
      corr({ action: "edit-text", target: eId(0), payload: { newText: "the corrected words", newTextSha256: sha256Text("the corrected words"), fromVersion: 1, version: 2 } }),
    ]);
    writeFileSync(path.join(w.vault, ".raw/docs/e5.md"), "changed on disk");
    const out = path.join(tmp("out"), "x.zip");
    const r = await exportRecord(w.ctx, w.ledger, out, STRINGS, { includeClosed: true, now: () => T0 });
    expect(r).toMatchObject({ entries: 6, excluded: 1, unreadable: 1 });
    const z = await readZip(out);
    const all = [...z.values()].map((b) => b.toString()).join("\n");
    expect(all).not.toContain("a life entry");
    const rows = z.get("entries/code/2026-11.jsonl")!.toString().trim().split("\n").map((l) => JSON.parse(l));
    const e0 = rows.find((x) => x.id === eId(0));
    expect(e0.text).toContain("entry number 0");
    expect(e0.edited).toMatchObject({ text: "the corrected words", version: 2 });
    expect(e0.sha256).toBe(sha256Text(e0.text));
    expect(z.get("entries/code/2026-11.md")!.toString()).toContain("the corrected words");
    const gone = z.get("entries/no-area/2026-11.jsonl")!.toString().trim().split("\n").map((l) => JSON.parse(l))[0];
    expect(gone.unreadable).toBe(true);
    expect(gone.text).toBeUndefined();
    expect(JSON.parse(z.get("manifest.json")!.toString()).counts).toMatchObject({ unreadable: 1, excluded: 1 });
    // the corrected text is not what was sealed, and the pack still checks out because the original is kept
    expect((await V.verifyFiles(asFiles(z), opts)).ok).toBe(true);
  });

  it("works on an empty record", async () => {
    const w = await world();
    const out = path.join(tmp("out"), "empty.zip");
    const r = await exportRecord(w.ctx, w.ledger, out, STRINGS, { includeClosed: true, now: () => T0 });
    expect(r.entries).toBe(0);
    const z = await readZip(out);
    expect(z.has("manifest.json")).toBe(true);
    const v = await V.verifyFiles(asFiles(z), opts);
    expect(v.ok).toBe(true);
  });
});

// ───────────────────────────── optional encryption ─────────────────────────────

describe("encrypting an export", () => {
  const key = new Uint8Array(32).map((_, i) => i + 1);

  it("round-trips, uses a fresh salt and nonce each time, and rejects a wrong key or a changed byte", () => {
    const plain = Buffer.from("PK zip bytes ".repeat(100));
    const a = encryptExportBytes(plain, key);
    const b = encryptExportBytes(plain, key);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a.subarray(0, 4)).toString()).toBe("CXX1");
    expect(Buffer.from(a.subarray(4, 20)).equals(Buffer.from(b.subarray(4, 20)))).toBe(false);
    expect(Buffer.from(decryptExportBytes(a, key)!).equals(plain)).toBe(true);
    expect(decryptExportBytes(a, new Uint8Array(32).fill(9))).toBeNull();
    const tampered = Buffer.from(a);
    tampered[tampered.length - 5]! ^= 1;
    expect(decryptExportBytes(tampered, key)).toBeNull();
    const saltChanged = Buffer.from(a);
    saltChanged[6]! ^= 1;
    expect(decryptExportBytes(saltChanged, key)).toBeNull();
    expect(decryptExportBytes(Buffer.from("not an export"), key)).toBeNull();
    expect(() => encryptExportBytes(plain, new Uint8Array(16))).toThrow();
    expect(plain.includes(Buffer.from(a).subarray(30))).toBe(false);
  });

  it("replaces the plain zip with a verified encrypted file", async () => {
    const dir = tmp("enc");
    const zip = path.join(dir, "r.zip");
    const z = new ZipWriter(zip);
    await z.add("a.txt", "secret words in a record");
    await z.finish();
    const plain = readFileSync(zip);
    const out = await encryptExportFile(zip, key);
    expect(out).toBe(`${zip}.cortexenc`);
    expect(existsSync(zip)).toBe(false);
    const enc = readFileSync(out);
    expect(enc.includes(Buffer.from("secret words"))).toBe(false);
    expect(Buffer.from(decryptExportBytes(enc, key)!).equals(plain)).toBe(true);
    expect(heldVaultKey()).toBeNull();
  });
});

// ───────────────────────────── the runner commands ─────────────────────────────

function hostFor() {
  const events: unknown[] = [];
  const host = { mode: "inline", log: nullLogger, emit: (e: unknown) => events.push(e), cancelSource: createCancelSource() } as unknown as RunnerHost;
  return { host, events };
}
function ctxFor(w: W): RunnerContext {
  return { vaultRoot: w.vault, vaultKey: path.basename(w.cache), cacheDir: w.cache, settings: DEFAULT_SETTINGS, pluginVersion: "9.9.9", settingsSource: "plugin" } as unknown as RunnerContext;
}
const rcFor = (w: W) => {
  const { host } = hostFor();
  return { ctx: ctxFor(w), host, id: "r1", cancel: createCancelSource().token } as never;
};

describe("the runner commands", () => {
  it("proof.entry, audit.pack and export.record write a zip where asked and refuse unsafe targets", async () => {
    const w = await world();
    await w.ledger.append("entries", [0, 1].map((n) => entry(w, n)));
    await sealed(w, { confirm: true });
    const h = createHandlers();
    const dir = tmp("out");
    const rc = rcFor(w);
    const p = await h["proof.entry"]({ id: eId(1), out: path.join(dir, "proof.zip"), strings: STRINGS }, rc);
    expect(p).toMatchObject({ block: 1, stamped: true });
    expect(existsSync(path.join(dir, "proof.zip"))).toBe(true);
    const a = await h["audit.pack"]({ out: path.join(dir, "audit.zip"), strings: STRINGS }, rc);
    expect(a).toMatchObject({ blocks: 1, anchors: 1 });
    const e = await h["export.record"]({ out: path.join(dir, "export.zip"), strings: STRINGS, areas: [], includeClosed: true, openSpaces: [] }, rc);
    expect(e).toMatchObject({ entries: 2 });
    await expect(h["export.record"]({ out: "relative.zip", strings: STRINGS, areas: [], includeClosed: true, openSpaces: [] }, rc)).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(h["audit.pack"]({ out: path.join(dir, "x.txt"), strings: STRINGS }, rc)).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(h["audit.pack"]({ out: path.join(w.vault, ".obsidian", "x.zip"), strings: STRINGS }, rc)).rejects.toMatchObject({ code: "E_PATH_DENIED" });
    await expect(h["audit.pack"]({ out: path.join(w.vault, ".vault-meta", "cortex", "x.zip"), strings: STRINGS }, rc)).rejects.toMatchObject({ code: "E_PATH_DENIED" });
  });
});
