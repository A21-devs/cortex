/**
 * The pure half of block signing (Ed25519 itself lives in src/node/sign.ts, on node:crypto; nothing here
 * invents a primitive). What is signed, how a key is named for people, and the shape of a proof bundle.
 *
 * A signed statement is plain text, so anyone can rebuild it from a block and check the signature with any
 * Ed25519 tool: "cortex-seal-signature 2", the block hash, and (only when the person chose one) a display
 * name. Owner: seal-date-v2.
 */
import { sha256Hex } from "./sha256";

export const SIGNATURE_PREFIX = "cortex-seal-signature 2";
/** Display names are short plain text; anything else is trimmed away before it is signed. */
export const SIGNER_NAME_MAX = 80;

/** A display name made safe to sign: one line, no control characters, at most SIGNER_NAME_MAX characters. */
export function cleanSignerName(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, SIGNER_NAME_MAX);
}

/** The exact text that is signed for one block. */
export function signedStatement(blockHash: string, name?: string): string {
  const who = cleanSignerName(name);
  return who === "" ? `${SIGNATURE_PREFIX}\n${blockHash}` : `${SIGNATURE_PREFIX}\n${blockHash}\nsigned by: ${who}`;
}

/** "a1b2 c3d4 e5f6 0718 293a": the first 20 hex digits of sha256(public key), grouped for reading aloud. */
export function keyFingerprint(publicKeyHex: string): string {
  const digest = sha256Hex(hexToBytes(publicKeyHex));
  return (digest.slice(0, 20).match(/.{4}/g) ?? []).join(" ");
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("not hexadecimal");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function isHex(s: unknown, bytes: number): s is string {
  return typeof s === "string" && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);
}
