/**
 * The flows behind "Prove this entry", "Audit pack" and "Export my record" (commands, the entry reader's date-evidence
 * disclosure, You and the File menu). The person picks where the file goes; the background program builds the zip at
 * that path and answers with counts; this file turns the answer into one notice. Works in Obsidian and in Cortex
 * Desktop (the Save dialog is feature-detected in saveFile.ts). Owner: proof-audit-export.
 */
import { effectiveOpenSpaces } from "../shared/consent";
import { isCortexError } from "../shared/errors";
import { heldVaultKey, recordKeyState } from "../shared/crypto/keyring";
import { t } from "../ui/copy";
import { chooseSavePath, type SaveDeps } from "./saveFile";
import type { CortexServices } from "./services";
import { verifierStrings } from "./verifierStrings";

export type Notice = (text: string) => void;

export interface ExportChoice {
  areas: string[];
  from?: string;
  to?: string;
  includeClosed: boolean;
  encrypt: boolean;
}

type Deps = Pick<SaveDeps, "dialog" | "home" | "exists">;

/** `20261103-1405`, local time, for file names. */
export function stamp(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** What went wrong, in catalogue words. */
export function packFailure(e: unknown): string {
  if (isCortexError(e)) {
    const reason = typeof e.detail?.reason === "string" ? e.detail.reason : "";
    if (reason === "not-sealed") return t("proof.notSealed");
    if (reason === "salt-elsewhere") return t("proof.saltElsewhere");
    if (reason === "text-missing" || reason === "text-changed") return t("proof.textMissing");
    if (reason === "zip-limit") return t("proof.exportTooBig");
    if (reason === "no-grant") return t("consent.noGrant");
  }
  return t("proof.failed");
}

/** A name typed in the Save dialog without an extension still gets .zip. */
export const withZip = (p: string): string => (/\.zip$/i.test(p) ? p : `${p}.zip`);

const refuseSample = (s: CortexServices, notice: Notice): boolean => {
  if (!s.sandbox.value) return false;
  notice(t("proof.sample"));
  return true;
};

/** "Prove this entry": a zip with the entry, its seal and the offline checker. Resolves to the path, or null when cancelled or refused. */
export async function proveEntry(s: CortexServices, id: string, notice: Notice, deps: Deps = {}): Promise<string | null> {
  if (refuseSample(s, notice)) return null;
  try {
    const chosen = await chooseSavePath({ suggestedName: `cortex-proof-${id.slice(2, 10)}-${stamp()}.zip`, mime: "application/zip" }, deps);
    if (!chosen) return null;
    const out = withZip(chosen);
    notice(t("proof.working"));
    await s.runner.request({ cmd: "proof.entry", args: { id, out, strings: verifierStrings() } });
    notice(t("proof.proofSaved", { path: out }));
    return out;
  } catch (e) {
    notice(packFailure(e));
    return null;
  }
}

/** "Audit pack": a zip a chosen person can check without opening any text. */
export async function makeAuditPack(s: CortexServices, notice: Notice, deps: Deps = {}): Promise<string | null> {
  if (refuseSample(s, notice)) return null;
  try {
    const chosen = await chooseSavePath({ suggestedName: `cortex-audit-pack-${stamp()}.zip`, mime: "application/zip" }, deps);
    if (!chosen) return null;
    const out = withZip(chosen);
    notice(t("proof.working"));
    await s.runner.request({ cmd: "audit.pack", args: { out, strings: verifierStrings() } });
    notice(t("proof.auditSaved", { path: out }));
    return out;
  } catch (e) {
    notice(packFailure(e));
    return null;
  }
}

/** "Export my record" with the choices from the dialog. */
export async function exportMyRecord(s: CortexServices, choice: ExportChoice, notice: Notice, deps: Deps = {}): Promise<string | null> {
  if (refuseSample(s, notice)) return null;
  try {
    const chosen = await chooseSavePath({ suggestedName: `cortex-record-${stamp()}.zip`, mime: "application/zip" }, deps);
    if (!chosen) return null;
    const out = withZip(chosen);
    notice(t("proof.working"));
    const r = await s.runner.request({
      cmd: "export.record",
      args: {
        out,
        strings: verifierStrings(),
        areas: choice.areas,
        ...(choice.from ? { from: choice.from } : {}),
        ...(choice.to ? { to: choice.to } : {}),
        includeClosed: choice.includeClosed,
        openSpaces: effectiveOpenSpaces(s.settings.value.consent, s.settings.value.userSpaces ?? []),
      },
    });
    if (r.entries === 0) {
      notice(t("proof.exportEmpty"));
      return null;
    }
    // Consent: what an export read counts against the grant it was made under.
    if (r.grant !== undefined) {
      await s.settings
        .update((x) => {
          const g = x.consent.grants.find((y) => y.id === r.grant);
          if (g) g.reads += r.entries;
        })
        .catch(() => undefined);
    }
    let where = out;
    const key = heldVaultKey();
    if (choice.encrypt && recordKeyState() === "open" && key) {
      try {
        const { encryptExportFile } = await import("../store/exportCrypto");
        where = await encryptExportFile(out, key);
      } catch {
        notice(t("proof.exportEncryptFailed"));
        return null;
      }
    }
    const left = r.skippedClosed + r.excluded > 0 ? ` ${t("proof.exportDoneLeft", { closed: r.skippedClosed, excluded: r.excluded })}` : "";
    const unread = r.unreadable > 0 ? ` ${t("proof.exportDoneUnreadable", { n: r.unreadable })}` : "";
    notice(`${t("proof.exportDone", { n: r.entries, path: where })}${left}${unread}`);
    return where;
  } catch (e) {
    notice(packFailure(e));
    return null;
  }
}

/**
 * "Open an encrypted export": the person chose a `.cortexenc` file; with the record open its zip is rebuilt in memory and saved
 * where they choose. A wrong key or a changed file is told apart from "not an export" only as far as the format allows (the
 * tag check cannot say which). Nothing is written until the file opens.
 */
export async function openEncryptedExport(s: CortexServices, file: { name: string; bytes: Uint8Array }, notice: Notice): Promise<string | null> {
  const key = heldVaultKey();
  if (!key || recordKeyState() !== "open") {
    notice(t("proof.openExportNeedKey"));
    return null;
  }
  try {
    const { decryptExportBytes, EXPORT_MAGIC } = await import("../store/exportCrypto");
    if (file.bytes.length < EXPORT_MAGIC.length || !EXPORT_MAGIC.equals(Buffer.from(file.bytes.subarray(0, EXPORT_MAGIC.length)))) {
      notice(t("proof.openExportNotExport"));
      return null;
    }
    const plain = decryptExportBytes(file.bytes, key);
    if (!plain) {
      notice(t("proof.openExportWrong"));
      return null;
    }
    const base = file.name.replace(/\.cortexenc$/i, "").replace(/\.zip$/i, "") || "cortex-export";
    const where = await s.save({ suggestedName: `${base}-opened.zip`, mime: "application/zip", data: plain });
    if (where) notice(t("proof.openExportDone", { path: where }));
    return where;
  } catch {
    notice(t("proof.failed"));
    return null;
  }
}
