/**
 * "This Windows account": the record's vault key sealed with Electron's safeStorage (DPAPI on Windows, so only this
 * Windows sign-in can open it). The main process does the sealing (main.ts, `cortex:os-key`); this is the renderer's
 * bridge the plugin finds on `globalThis.__cortexOsKey` (plugin/recordKeys.ts). Never installed in screenshot runs.
 */
import { ipcRenderer } from "electron";
import { fromBase64, toBase64 } from "../shared/crypto/vaultKey";
import type { OsKeyBridge } from "../shared/crypto/access";

export function createOsKeyBridge(invoke: (op: string, data?: string) => Promise<unknown> = (op, data) => ipcRenderer.invoke("cortex:os-key", op, data)): OsKeyBridge {
  return {
    async available() {
      try {
        return (await invoke("available")) === true;
      } catch {
        return false;
      }
    },
    async protect(key) {
      try {
        const r = await invoke("protect", toBase64(key));
        return typeof r === "string" && r.length > 0 ? r : null;
      } catch {
        return null;
      }
    },
    async unprotect(blob) {
      try {
        const r = await invoke("unprotect", blob);
        return typeof r === "string" ? fromBase64(r) : null;
      } catch {
        return null;
      }
    },
  };
}

export function installOsKeyBridge(): void {
  (globalThis as { __cortexOsKey?: OsKeyBridge }).__cortexOsKey = createOsKeyBridge();
}
