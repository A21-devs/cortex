import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_KDF_VERSION,
  FRAME_OVERHEAD,
  KDF_VERSIONS,
  envelopeIsOld,
  generateVaultKey,
  keyId,
  lineFrame,
  lineText,
  openFrame,
  parseEnvelope,
  parseFrame,
  sealFrame,
  unwrapVaultKey,
  wrapVaultKey,
} from "../src/shared/crypto/vaultKey";
import { decodeFileWith, decodeLineBytesWith, encodeFileWith, encodeLineWith, openFrameSync, sealFrameSync } from "../src/node/vaultCipher";
import { dropVaultKey, heldVaultKey, holdVaultKey, recordKeyState, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("frames (AES-256-GCM)", () => {
  it("round-trips a file frame and a line frame", async () => {
    const key = generateVaultKey();
    const text = "verbatim text with unicode é中";
    for (const kind of ["file", "line"] as const) {
      const f = await sealFrame(key, enc(text), kind);
      expect(f.length).toBe(FRAME_OVERHEAD + enc(text).length);
      expect(parseFrame(f)?.kind).toBe(kind);
      expect(dec((await openFrame(key, f, kind)) as Uint8Array)).toBe(text);
    }
  });

  it("uses a fresh nonce every time and never repeats the ciphertext", async () => {
    const key = generateVaultKey();
    const nonces = new Set<string>();
    const bodies = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const f = await sealFrame(key, enc("same"), "line");
      nonces.add(Buffer.from((parseFrame(f) as { nonce: Uint8Array }).nonce).toString("hex"));
      bodies.add(Buffer.from(f).toString("hex"));
    }
    expect(nonces.size).toBe(50);
    expect(bodies.size).toBe(50);
  });

  it("detects any changed byte, a wrong key, a wrong kind and a truncated frame", async () => {
    const key = generateVaultKey();
    const f = await sealFrame(key, enc("the record"), "file");
    for (let i = 0; i < f.length; i++) {
      const bad = Uint8Array.from(f);
      bad[i] = (bad[i] as number) ^ 0x01;
      expect(await openFrame(key, bad)).toBeNull();
    }
    expect(await openFrame(generateVaultKey(), f)).toBeNull();
    expect(await openFrame(key, f, "line")).toBeNull();
    expect(await openFrame(key, f.subarray(0, f.length - 1))).toBeNull();
    expect(await openFrame(key, f.subarray(0, 10))).toBeNull();
  });

  it("matches the AES-GCM reference built by hand from the documented layout", async () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(12, 9);
    const header = Buffer.from([0x43, 0x58, 0x45, 0x31, 1, 1]);
    const c = createCipheriv("aes-256-gcm", key, nonce);
    c.setAAD(header);
    const ct = Buffer.concat([c.update("abc"), c.final()]);
    const frame = new Uint8Array(Buffer.concat([header, nonce, ct, c.getAuthTag()]));
    expect(dec(openFrameSync(key, frame, "file") as Uint8Array)).toBe("abc");
    expect(dec((await openFrame(key, frame, "file")) as Uint8Array)).toBe("abc");
  });

  it("the WebCrypto and Node implementations read each other's frames", async () => {
    const key = generateVaultKey();
    const a = await sealFrame(key, enc("from web crypto"), "line");
    expect(dec(openFrameSync(key, a, "line") as Uint8Array)).toBe("from web crypto");
    const b = sealFrameSync(key, enc("from node"), "file");
    expect(dec((await openFrame(key, b, "file")) as Uint8Array)).toBe("from node");
  });

  it("line text is CXE1: plus base64 and reads back", async () => {
    const key = generateVaultKey();
    const text = lineText(await sealFrame(key, enc('{"id":"e1"}'), "line"));
    expect(text.startsWith("CXE1:")).toBe(true);
    expect(text).not.toContain("\n");
    const frame = lineFrame(text) as Uint8Array;
    expect(dec((await openFrame(key, frame, "line")) as Uint8Array)).toBe('{"id":"e1"}');
    expect(lineFrame("{}")).toBeNull();
    expect(lineFrame("CXE1:***")).toBeNull();
  });
});

describe("passphrase envelope", () => {
  it("wraps and unwraps; a wrong passphrase gets nothing", async () => {
    const key = generateVaultKey();
    const env = await wrapVaultKey(key, "correct horse battery staple");
    expect(env.kdfVersion).toBe(CURRENT_KDF_VERSION);
    expect(env.iterations).toBe(KDF_VERSIONS[CURRENT_KDF_VERSION]);
    expect(JSON.stringify(env)).not.toContain(Buffer.from(key).toString("hex"));
    expect(Buffer.from((await unwrapVaultKey(env, "correct horse battery staple")) as Uint8Array).equals(Buffer.from(key))).toBe(true);
    expect(await unwrapVaultKey(env, "wrong")).toBeNull();
    expect(env.keyId).toBe(await keyId(key));
  }, 20_000);

  it("a different salt and nonce each time; passphrases are NFKC-normalised", async () => {
    const key = generateVaultKey();
    const a = await wrapVaultKey(key, "pass", 1);
    const b = await wrapVaultKey(key, "pass", 1);
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(await unwrapVaultKey(await wrapVaultKey(key, "ﬁx", 1), "fix")).not.toBeNull(); // the "fi" ligature normalises to "fi"
  }, 20_000);

  it("derives the wrapping key with PBKDF2-HMAC-SHA-256 at the stated rounds (reference check)", async () => {
    const key = generateVaultKey();
    const env = await wrapVaultKey(key, "reference", 1);
    const kek = pbkdf2Sync("reference", Buffer.from(env.salt, "hex"), env.iterations, 32, "sha256");
    const wrapped = Buffer.from(env.wrapped, "hex");
    const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(env.nonce, "hex"));
    d.setAAD(Buffer.from(`cortex-vault-key 1|${env.keyId}|${env.kdfVersion}|${env.iterations}`));
    d.setAuthTag(wrapped.subarray(32));
    const plain = Buffer.concat([d.update(wrapped.subarray(0, 32)), d.final()]);
    expect(plain.equals(Buffer.from(key))).toBe(true);
    expect(env.keyId).toBe(createHash("sha256").update(Buffer.concat([Buffer.from("cortex-key-id"), plain])).digest("hex").slice(0, 16));
  }, 20_000);

  it("tampering with the envelope (rounds, id, wrapped bytes) breaks the unwrap", async () => {
    const key = generateVaultKey();
    const env = await wrapVaultKey(key, "pw", 1);
    expect(await unwrapVaultKey({ ...env, iterations: env.iterations + 1 }, "pw")).toBeNull();
    expect(await unwrapVaultKey({ ...env, keyId: "0".repeat(16) }, "pw")).toBeNull();
    const w = env.wrapped.split("");
    w[0] = w[0] === "a" ? "b" : "a";
    expect(await unwrapVaultKey({ ...env, wrapped: w.join("") }, "pw")).toBeNull();
    expect(await unwrapVaultKey({ ...env, salt: "zz" }, "pw")).toBeNull();
  }, 20_000);

  it("parseEnvelope keeps a good envelope and refuses bad shapes and absurd round counts", async () => {
    const env = await wrapVaultKey(generateVaultKey(), "pw", 1);
    expect(parseEnvelope(JSON.parse(JSON.stringify(env)))).toEqual(env);
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope({ ...env, iterations: 1 })).toBeNull();
    expect(parseEnvelope({ ...env, iterations: 10 ** 9 })).toBeNull();
    expect(parseEnvelope({ ...env, v: 2 })).toBeNull();
    expect(parseEnvelope({ ...env, wrapped: "abcd" })).toBeNull();
    expect(parseEnvelope({ ...env, keyId: "xyz" })).toBeNull();
    expect(envelopeIsOld(env)).toBe(true);
    expect(envelopeIsOld({ kdfVersion: 2, iterations: 600_000 })).toBe(false);
  }, 20_000);
});

describe("keyring and the Node cipher", () => {
  beforeEach(() => resetKeyring());

  it("tracks plain, locked and open, and zeroes the key when dropped", () => {
    expect(recordKeyState()).toBe("plain");
    setEncryptionConfigured(true);
    expect(recordKeyState()).toBe("locked");
    holdVaultKey(generateVaultKey());
    expect(recordKeyState()).toBe("open");
    const held = heldVaultKey() as Uint8Array;
    dropVaultKey();
    expect(recordKeyState()).toBe("locked");
    expect(held.every((b) => b === 0)).toBe(true);
    expect(heldVaultKey()).toBeNull();
    setEncryptionConfigured(false);
    expect(recordKeyState()).toBe("plain");
  });

  it("lines: encrypted under a key, plain without one, tampered or wrong-key lines read as absent", () => {
    const key = generateVaultKey();
    const line = '{"id":"e1","text":"secret"}';
    const out = encodeLineWith(key, line);
    expect(out.startsWith("CXE1:")).toBe(true);
    expect(out).not.toContain("secret");
    expect(dec(decodeLineBytesWith(key, enc(out)) as Uint8Array)).toBe(line);
    expect(encodeLineWith(null, line)).toBe(line);
    expect(dec(decodeLineBytesWith(null, enc(line)) as Uint8Array)).toBe(line); // a legacy plain line
    expect(decodeLineBytesWith(null, enc(out))).toBeNull(); // locked
    expect(decodeLineBytesWith(generateVaultKey(), enc(out))).toBeNull(); // wrong key
    const chars = out.split("");
    chars[20] = chars[20] === "A" ? "B" : "A";
    expect(decodeLineBytesWith(key, enc(chars.join("")))).toBeNull(); // tampered
  });

  it("files: encrypted frame, legacy plain bytes pass through, locked and tampered files throw", () => {
    const key = generateVaultKey();
    const gz = Uint8Array.from([0x1f, 0x8b, 8, 0, 1, 2, 3]);
    const sealed = encodeFileWith(key, gz);
    expect(Buffer.from(sealed).includes(Buffer.from(gz))).toBe(false);
    expect(Buffer.from(decodeFileWith(key, sealed)).equals(Buffer.from(gz))).toBe(true);
    expect(decodeFileWith(null, gz)).toBe(gz);
    expect(() => decodeFileWith(null, sealed)).toThrow(/locked/);
    const bad = Uint8Array.from(sealed);
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect(() => decodeFileWith(key, bad)).toThrow(/did not open/);
    expect(() => decodeFileWith(generateVaultKey(), sealed)).toThrow(/did not open/);
  });
});

describe("the lock's passphrase rounds", () => {
  it("a new passphrase uses the current version; an older record still opens and is reported old", async () => {
    const { LOCK_ITERATIONS, LEGACY_LOCK_ITERATIONS, hashPassphrase, lockIsOld, verifyPassphrase } = await import("../src/shared/lock");
    expect(LOCK_ITERATIONS).toBe(KDF_VERSIONS[CURRENT_KDF_VERSION]);
    expect(LEGACY_LOCK_ITERATIONS).toBe(210_000);
    const fresh = await hashPassphrase("a passphrase");
    expect(fresh.iterations).toBe(LOCK_ITERATIONS);
    expect(lockIsOld(fresh)).toBe(false);
    const old = await hashPassphrase("an older one", LEGACY_LOCK_ITERATIONS);
    expect(lockIsOld(old)).toBe(true);
    expect(await verifyPassphrase("an older one", old)).toBe(true);
    expect(await verifyPassphrase("nope", old)).toBe(false);
    expect(lockIsOld({ salt: "", hash: "", iterations: 210_000 })).toBe(false);
  }, 20_000);
});
