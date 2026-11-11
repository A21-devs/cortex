import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { OsKeyBridge } from "../../src/shared/crypto/access";
import { fromBase64, toBase64 } from "../../src/shared/crypto/vaultKey";

/**
 * A stand-in for the desktop shell's safeStorage bridge: it seals with a throw-away AES-GCM key held in this object
 * (so only this "account" can open its blobs), the way DPAPI binds a blob to a Windows sign-in.
 */
export function createDesktopOsKeyForTest(available: boolean): OsKeyBridge {
  const accountKey = randomBytes(32);
  return {
    async available() {
      return available;
    },
    async protect(key) {
      if (!available) return null;
      const nonce = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", accountKey, nonce);
      const ct = Buffer.concat([c.update(key), c.final()]);
      return toBase64(Buffer.concat([nonce, ct, c.getAuthTag()]));
    },
    async unprotect(blob) {
      if (!available) return null;
      const raw = fromBase64(blob);
      if (!raw || raw.length < 12 + 16) return null;
      try {
        const d = createDecipheriv("aes-256-gcm", accountKey, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(raw.length - 16));
        return new Uint8Array(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]));
      } catch {
        return null;
      }
    },
  };
}
