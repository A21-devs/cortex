/**
 * Independent checks added by the record-security verification: bounded network replies, nonce uniqueness at scale,
 * the spread of a single Shamir share, and the share tag/id link. Nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import { MAX_PROOF_BYTES, readCapped } from "../src/store/otsProof";
import { sealFrameSync } from "../src/node/vaultCipher";
import { splitSecret } from "../src/shared/crypto/shamir";

const reply = (body: Uint8Array, headers: Record<string, string> = {}): Response => new Response(body as BodyInit, { headers });

describe("a service reply is read with a limit", () => {
  it("returns a small body whole", async () => {
    const out = await readCapped(reply(Uint8Array.from([1, 2, 3])), 10);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
  it("refuses a body over the limit, with or without a declared length", async () => {
    await expect(readCapped(reply(new Uint8Array(11)), 10)).rejects.toMatchObject({ code: "E_PARSE" });
    await expect(readCapped(reply(new Uint8Array(4), { "content-length": "999999999" }), 10)).rejects.toMatchObject({ code: "E_PARSE" });
  });
  it("stops reading a stream that never ends", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1000));
      },
    });
    await expect(readCapped(new Response(body), 5000)).rejects.toMatchObject({ code: "E_PARSE" });
    expect(pulls).toBeLessThan(20);
    expect(MAX_PROOF_BYTES).toBe(1_000_000);
  });
});

describe("AES-GCM frames", () => {
  it("never repeat a nonce across 20,000 frames under one key", () => {
    const key = new Uint8Array(32).fill(7);
    const seen = new Set<string>();
    const plain = new Uint8Array(8);
    for (let i = 0; i < 20_000; i++) seen.add(Buffer.from(sealFrameSync(key, plain, "line").subarray(6, 18)).toString("hex"));
    expect(seen.size).toBe(20_000);
  });
});

describe("a single Shamir share", () => {
  it("is spread over all byte values whatever the secret (2 of 3, point 1)", () => {
    for (const secretByte of [0x00, 0xff]) {
      const counts = new Array<number>(256).fill(0);
      const secret = new Uint8Array(32).fill(secretByte);
      for (let i = 0; i < 64; i++) for (const b of splitSecret(secret, 2, 3)[0]!.y) counts[b]!++;
      // 2048 samples over 256 values: expected 8 each; every value of a sound split appears, none dominates
      expect(counts.filter((c) => c === 0).length).toBeLessThan(8);
      expect(Math.max(...counts)).toBeLessThan(30);
    }
  });
});

describe("Open an encrypted export", () => {
  it("opens with the record's key, refuses a wrong key, a changed file and a plain file, and saves only on success", async () => {
    const { openEncryptedExport } = await import("../src/plugin/packs");
    const { encryptExportBytes } = await import("../src/store/exportCrypto");
    const { holdVaultKey, resetKeyring, setEncryptionConfigured } = await import("../src/shared/crypto/keyring");
    const key = new Uint8Array(32).fill(9);
    const zip = Uint8Array.from([0x50, 0x4b, 3, 4, 1, 2, 3]);
    const enc = encryptExportBytes(zip, key);
    const saved: { name: string; data: Uint8Array | string }[] = [];
    const sv = { save: async (r: { suggestedName: string; data: Uint8Array | string }) => (saved.push({ name: r.suggestedName, data: r.data }), `/out/${r.suggestedName}`) } as never;
    const notes: string[] = [];
    const notice = (x: string): void => void notes.push(x);

    resetKeyring();
    setEncryptionConfigured(true);
    expect(await openEncryptedExport(sv, { name: "a.zip.cortexenc", bytes: enc }, notice)).toBeNull(); // locked
    expect(notes.at(-1)).toMatch(/Unlock the record first/);

    holdVaultKey(key);
    const where = await openEncryptedExport(sv, { name: "a.zip.cortexenc", bytes: enc }, notice);
    expect(where).toBe("/out/a-opened.zip");
    expect(Array.from(saved[0]!.data as Uint8Array)).toEqual(Array.from(zip));

    const changed = Uint8Array.from(enc);
    changed[changed.length - 1] = (changed[changed.length - 1] as number) ^ 1;
    expect(await openEncryptedExport(sv, { name: "a.cortexenc", bytes: changed }, notice)).toBeNull();
    expect(notes.at(-1)).toMatch(/did not open with this record's key/);
    expect(await openEncryptedExport(sv, { name: "x.zip", bytes: zip }, notice)).toBeNull();
    expect(notes.at(-1)).toMatch(/not an encrypted Cortex export/);
    holdVaultKey(new Uint8Array(32).fill(1));
    expect(await openEncryptedExport(sv, { name: "a.cortexenc", bytes: enc }, notice)).toBeNull();
    expect(saved.length).toBe(1);
    resetKeyring();
  });
});
