/** Shamir sharing of the record key: the field, hand-made vectors, any k of n, fewer than k, the share codec and the words. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SHARE_WORDS } from "../src/shared/crypto/shareWords";
import {
  combineShares,
  combineVaultKey,
  decodeShare,
  encodeShare,
  gfDiv,
  gfMul,
  parseShareText,
  shareChecksum,
  shareToQrText,
  shareToWords,
  splitSecret,
  splitVaultKey,
  SHARE_BYTES,
  SHARE_WORD_COUNT,
  wordsOf,
  wordsToShare,
  type KeyShare,
} from "../src/shared/crypto/shamir";
import { generateVaultKey, keyId, sameBytes } from "../src/shared/crypto/vaultKey";

const decode = (b: Uint8Array): KeyShare => {
  const d = decodeShare(b);
  if (!d.ok) throw new Error(`decode failed: ${d.reason}`);
  return d.share;
};

describe("GF(256)", () => {
  it("matches the AES field: 0x57 * 0x83 = 0xc1, and division undoes multiplication", () => {
    expect(gfMul(0x57, 0x83)).toBe(0xc1);
    expect(gfMul(0x57, 0x13)).toBe(0xfe);
    for (let a = 1; a < 256; a += 7) for (let b = 1; b < 256; b += 11) expect(gfDiv(gfMul(a, b), b)).toBe(a);
    expect(gfMul(0, 77)).toBe(0);
    expect(() => gfDiv(5, 0)).toThrow();
  });
});

describe("splitting and combining", () => {
  it("rebuilds a hand-made polynomial: f(x) = 0x2a + 0x07 x gives 0x2d, 0x24, 0x23 at x = 1, 2, 3", () => {
    const shares = [
      { x: 1, y: Uint8Array.of(0x2d) },
      { x: 2, y: Uint8Array.of(0x24) },
      { x: 3, y: Uint8Array.of(0x23) },
    ];
    for (const pair of [[0, 1], [0, 2], [1, 2]]) expect(combineShares(pair.map((i) => shares[i] as (typeof shares)[number]))[0]).toBe(0x2a);
  });

  it("2 of 3: every pair rebuilds the key and no single share does", () => {
    const key = generateVaultKey();
    const shares = splitSecret(key, 2, 3);
    expect(shares.map((s) => s.x)).toEqual([1, 2, 3]);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) expect(sameBytes(combineShares([shares[a] as (typeof shares)[number], shares[b] as (typeof shares)[number]]), key)).toBe(true);
    for (const s of shares) expect(sameBytes(s.y, key)).toBe(false);
    // one share is not the key and carries nothing a second copy of the same share could add
    expect(() => combineShares([shares[0] as (typeof shares)[number], shares[0] as (typeof shares)[number]])).toThrow();
  });

  it("3 of 5: every group of three rebuilds the key; groups of two do not", () => {
    const key = generateVaultKey();
    const shares = splitSecret(key, 3, 5);
    let good = 0;
    let bad = 0;
    for (let a = 0; a < 5; a++)
      for (let b = a + 1; b < 5; b++) {
        const two = combineShares([shares[a], shares[b]] as (typeof shares)[number][]);
        if (sameBytes(two, key)) bad++;
        for (let c = b + 1; c < 5; c++) if (sameBytes(combineShares([shares[a], shares[b], shares[c]] as (typeof shares)[number][]), key)) good++;
      }
    expect(good).toBe(10);
    expect(bad).toBe(0);
  });

  it("a different split of the same key gives different shares, and shares of two splits do not combine", () => {
    const key = generateVaultKey();
    const a = splitSecret(key, 2, 3);
    const b = splitSecret(key, 2, 3);
    expect(sameBytes((a[1] as (typeof a)[number]).y, (b[1] as (typeof b)[number]).y)).toBe(false);
    expect(sameBytes(combineShares([a[0] as (typeof a)[number], b[1] as (typeof b)[number]]), key)).toBe(false);
  });

  it("refuses bad parameters", () => {
    expect(() => splitSecret(new Uint8Array(32), 1, 3)).toThrow();
    expect(() => splitSecret(new Uint8Array(32), 4, 3)).toThrow();
    expect(() => splitSecret(new Uint8Array(32), 2, 11)).toThrow();
    expect(() => combineShares([{ x: 1, y: new Uint8Array(32) }])).toThrow();
  });
});

describe("the share format", () => {
  it("is 40 bytes with a threshold, a point, the key tag and a check, and round-trips", async () => {
    const key = generateVaultKey();
    const id = await keyId(key);
    const shares = splitVaultKey(key, id, 2, 3);
    expect(shares.every((s) => s.length === SHARE_BYTES)).toBe(true);
    const d = decode(shares[1] as Uint8Array);
    expect(d.k).toBe(2);
    expect(d.x).toBe(2);
    expect(d.tag).toBe(id.slice(0, 8));
    expect(sameBytes(encodeShare(d), shares[1] as Uint8Array)).toBe(true);
  });

  it("any 2 of 3 rebuild the key from decoded shares and 1 of 3 is refused", async () => {
    const key = generateVaultKey();
    const id = await keyId(key);
    const shares = splitVaultKey(key, id, 2, 3).map(decode);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) {
      const r = combineVaultKey([shares[a] as KeyShare, shares[b] as KeyShare]);
      expect(r.ok && sameBytes(r.key, key) && (await keyId(r.key)) === id).toBe(true);
    }
    expect(combineVaultKey([shares[0] as KeyShare])).toEqual({ ok: false, reason: "few" });
    expect(combineVaultKey([shares[0] as KeyShare, shares[0] as KeyShare])).toEqual({ ok: false, reason: "few" });
    expect(combineVaultKey([])).toEqual({ ok: false, reason: "few" });
  });

  it("shares of two different keys are told apart", async () => {
    const a = generateVaultKey();
    const b = generateVaultKey();
    const sa = splitVaultKey(a, await keyId(a), 2, 3).map(decode);
    const sb = splitVaultKey(b, await keyId(b), 2, 3).map(decode);
    expect(combineVaultKey([sa[0] as KeyShare, sb[1] as KeyShare])).toEqual({ ok: false, reason: "mixed" });
  });

  it("a changed byte fails the check code", async () => {
    const key = generateVaultKey();
    const share = splitVaultKey(key, await keyId(key), 2, 3)[0] as Uint8Array;
    for (const at of [1, 5, 20, 37, 38]) {
      const bad = share.slice();
      bad[at] = (bad[at] as number) ^ 1;
      expect(decodeShare(bad).ok).toBe(false);
    }
    expect(decodeShare(share.subarray(0, 39))).toEqual({ ok: false, reason: "length" });
  });

  it("the checksum is stable, differs per share, and has the a1b2-c3d4 form", async () => {
    const key = generateVaultKey();
    const shares = splitVaultKey(key, await keyId(key), 2, 3);
    const codes = shares.map(shareChecksum);
    expect(codes.every((c) => /^[0-9a-f]{4}-[0-9a-f]{4}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(3);
    expect(shareChecksum(shares[0] as Uint8Array)).toBe(codes[0]);
  });
});

describe("words", () => {
  it("the list has 1,024 distinct lower-case words, and its hash is pinned", () => {
    expect(SHARE_WORDS.length).toBe(1024);
    expect(new Set(SHARE_WORDS).size).toBe(1024);
    expect(SHARE_WORDS.every((w) => /^[a-z]{3,10}$/.test(w))).toBe(true);
    expect(createHash("sha256").update(SHARE_WORDS.join(" ")).digest("hex").slice(0, 16)).toBe("d123426cd7c7fc02");
  });

  it("a share is 32 words and reads back to the same bytes, in any case, with numbers and odd spacing", async () => {
    const key = generateVaultKey();
    const share = splitVaultKey(key, await keyId(key), 2, 3)[2] as Uint8Array;
    const words = shareToWords(share);
    expect(words.length).toBe(SHARE_WORD_COUNT);
    const r = wordsToShare(words);
    expect(r.ok && sameBytes(r.bytes, share)).toBe(true);
    const messy = words.map((w, i) => `${i + 1}. ${i % 3 === 0 ? w.toUpperCase() : w}`).join(",  ");
    const parsed = parseShareText(messy);
    expect(parsed.ok && sameBytes(parsed.bytes, share)).toBe(true);
    expect(wordsOf("1) able, Acid-acorn\nactor")).toEqual(["able", "acid", "acorn", "actor"]);
  });

  it("a wrong word, a missing word and a swapped pair are all caught", async () => {
    const key = generateVaultKey();
    const share = splitVaultKey(key, await keyId(key), 2, 3)[0] as Uint8Array;
    const words = shareToWords(share);
    expect(parseShareText([...words.slice(0, 31)].join(" "))).toMatchObject({ ok: false, reason: "length" });
    expect(parseShareText([...words.slice(0, 31), "zzzzzz"].join(" "))).toMatchObject({ ok: false, reason: "word", at: 31 });
    const swapped = [...words];
    [swapped[3], swapped[4]] = [swapped[4] as string, swapped[3] as string];
    if (swapped[3] !== swapped[4]) expect(parseShareText(swapped.join(" "))).toMatchObject({ ok: false, reason: "check" });
    const other = [...words];
    other[10] = other[10] === "able" ? "acid" : "able";
    expect(parseShareText(other.join(" ")).ok).toBe(false);
  });

  it("the QR text is CXS1: and base64url, and reads back", async () => {
    const key = generateVaultKey();
    const share = splitVaultKey(key, await keyId(key), 2, 3)[1] as Uint8Array;
    const text = shareToQrText(share);
    expect(text).toMatch(/^CXS1:[A-Za-z0-9_-]{54}$/);
    const r = parseShareText(`  ${text}\n`);
    expect(r.ok && sameBytes(r.bytes, share)).toBe(true);
    expect(parseShareText("CXS1:!!!!")).toMatchObject({ ok: false });
    expect(parseShareText(text.slice(0, 20)).ok).toBe(false);
  });
});
